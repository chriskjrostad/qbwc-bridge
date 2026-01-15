/**
 * QuickBooks Web Connector SOAP Bridge
 *
 * This Cloud Function handles SOAP requests from QuickBooks Web Connector
 * and syncs time tracking data from the Tripp In maintenance portal.
 */

const { parseStringPromise, Builder } = require('xml2js');
const { getQBSyncPendingEntries, markEntriesQBSynced } = require('./sheets');
const { buildTimeTrackingAddXML } = require('./qbxml');

// Configuration - set these via environment variables or Secret Manager
const CONFIG = {
  username: process.env.QBWC_USERNAME || 'trippinqb',
  password: process.env.QBWC_PASSWORD || 'changeme123',  // Change in production!
  appName: 'Tripp In Time Sync',
  appDescription: 'Syncs employee time entries from Tripp In maintenance portal'
};

// Session state (in production, use Cloud Datastore or Redis)
const sessions = new Map();

/**
 * Main HTTP handler for Cloud Function
 */
exports.qbwcHandler = async (req, res) => {
  // Extract path from URL
  const urlPath = req.url.split('?')[0];

  // Handle GET requests (for certificate verification and support)
  if (req.method === 'GET') {
    // WSDL request (at root or /qbwc)
    if (req.query.wsdl !== undefined) {
      res.set('Content-Type', 'text/xml');
      res.send(getWSDL());
      return;
    }

    // Support page
    if (req.url.includes('/support')) {
      res.set('Content-Type', 'text/html');
      res.send(`<!DOCTYPE html>
<html><head><title>Tripp In Time Sync - Support</title></head>
<body style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto;">
<h1>Tripp In Time Sync</h1>
<p>QuickBooks Web Connector integration for Tripp In maintenance portal.</p>
<p>For support, contact your administrator.</p>
</body></html>`);
      return;
    }

    // /qbwc endpoint GET - return quick 200 OK
    if (urlPath === '/qbwc' || urlPath === '/qbwc/') {
      res.set('Content-Type', 'text/plain');
      res.send('OK');
      return;
    }

    // Root GET - return simple OK for certificate verification
    res.set('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html><head><title>QBWC Bridge</title></head>
<body><h1>QBWC Bridge Active</h1><p>QuickBooks Web Connector endpoint.</p></body></html>`);
    return;
  }

  // Handle SOAP POST (at root or /qbwc)
  if (req.method === 'POST') {
    try {
      const soapBody = req.body;
      const response = await handleSOAPRequest(soapBody);
      res.set('Content-Type', 'text/xml; charset=utf-8');
      res.send(response);
    } catch (error) {
      console.error('SOAP Error:', error);
      res.status(500).send(buildSOAPFault(error.message));
    }
    return;
  }

  res.status(405).send('Method not allowed');
};

/**
 * Parse and route SOAP requests
 */
async function handleSOAPRequest(xmlBody) {
  const parsed = await parseStringPromise(xmlBody, { explicitArray: false });
  const envelope = parsed['soap:Envelope'] || parsed['SOAP-ENV:Envelope'] || parsed.Envelope;
  const body = envelope['soap:Body'] || envelope['SOAP-ENV:Body'] || envelope.Body;

  // Find the method being called
  const methods = Object.keys(body);
  const methodKey = methods.find(m => !m.startsWith('xmlns'));

  if (!methodKey) {
    throw new Error('Unknown SOAP method');
  }

  const methodName = methodKey.replace(/^[^:]+:/, ''); // Remove namespace prefix
  const params = body[methodKey];

  console.log(`QBWC Method: ${methodName}`);

  // Route to appropriate handler
  switch (methodName) {
    case 'serverVersion':
      return buildResponse('serverVersionResponse', { serverVersionResult: '1.0.0' });

    case 'clientVersion':
      return handleClientVersion(params);

    case 'authenticate':
      return handleAuthenticate(params);

    case 'sendRequestXML':
      return handleSendRequestXML(params);

    case 'receiveResponseXML':
      return handleReceiveResponseXML(params);

    case 'connectionError':
      return handleConnectionError(params);

    case 'getLastError':
      return handleGetLastError(params);

    case 'closeConnection':
      return handleCloseConnection(params);

    default:
      throw new Error(`Unknown method: ${methodName}`);
  }
}

/**
 * Handle clientVersion - check if client version is compatible
 */
function handleClientVersion(params) {
  const clientVersion = params.strVersion || '';
  console.log(`Client version: ${clientVersion}`);

  // Return empty string = compatible, or warning message
  return buildResponse('clientVersionResponse', { clientVersionResult: '' });
}

/**
 * Handle authenticate - validate username/password
 */
function handleAuthenticate(params) {
  const username = params.strUserName || '';
  const password = params.strPassword || '';

  console.log(`Auth attempt for user: ${username}`);

  if (username === CONFIG.username && password === CONFIG.password) {
    // Generate session ticket
    const ticket = `TICKET-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    sessions.set(ticket, {
      authenticated: true,
      pendingEntries: [],
      currentIndex: 0,
      lastError: ''
    });

    console.log(`Auth successful, ticket: ${ticket}`);

    // Return: [ticket, status]
    // Status: empty = have work, "none" = no work, "nvu" = invalid user
    return buildResponse('authenticateResponse', {
      authenticateResult: {
        string: [ticket, '']  // Empty string = we have work to do
      }
    });
  }

  // Invalid credentials
  return buildResponse('authenticateResponse', {
    authenticateResult: {
      string: ['', 'nvu']  // "nvu" = not valid user
    }
  });
}

/**
 * Handle sendRequestXML - return QBXML commands to execute
 */
async function handleSendRequestXML(params) {
  const ticket = params.ticket || '';
  const session = sessions.get(ticket);

  if (!session || !session.authenticated) {
    return buildResponse('sendRequestXMLResponse', { sendRequestXMLResult: '' });
  }

  try {
    // First call - fetch pending entries
    if (session.pendingEntries.length === 0 && session.currentIndex === 0) {
      console.log('Fetching pending entries from Google Sheets...');
      session.pendingEntries = await getQBSyncPendingEntries();
      console.log(`Found ${session.pendingEntries.length} entries to sync`);
    }

    // Check if we have more entries to process
    if (session.currentIndex >= session.pendingEntries.length) {
      // No more work
      console.log('No more entries to sync');
      return buildResponse('sendRequestXMLResponse', { sendRequestXMLResult: '' });
    }

    // Get next entry and build QBXML
    const entry = session.pendingEntries[session.currentIndex];
    console.log(`Building QBXML for entry ${session.currentIndex + 1}/${session.pendingEntries.length}: ${entry.ID}`);

    const qbxml = buildTimeTrackingAddXML(entry);

    return buildResponse('sendRequestXMLResponse', { sendRequestXMLResult: qbxml });
  } catch (error) {
    console.error('Error in sendRequestXML:', error);
    session.lastError = error.message;
    return buildResponse('sendRequestXMLResponse', { sendRequestXMLResult: '' });
  }
}

/**
 * Handle receiveResponseXML - process QuickBooks response
 */
async function handleReceiveResponseXML(params) {
  const ticket = params.ticket || '';
  const response = params.response || '';
  const session = sessions.get(ticket);

  if (!session) {
    return buildResponse('receiveResponseXMLResponse', { receiveResponseXMLResult: -1 });
  }

  try {
    // Parse QB response
    const parsed = await parseStringPromise(response, { explicitArray: false });

    // Check for success
    const qbxml = parsed.QBXML;
    const msgsRs = qbxml?.QBXMLMsgsRs;
    const timeTrackingRs = msgsRs?.TimeTrackingAddRs;

    if (timeTrackingRs) {
      const statusCode = timeTrackingRs.$.statusCode;
      const statusMessage = timeTrackingRs.$.statusMessage;

      if (statusCode === '0') {
        // Success - mark entry as synced
        const entry = session.pendingEntries[session.currentIndex];
        console.log(`Successfully synced entry: ${entry.ID}`);
        await markEntriesQBSynced([entry.ID]);
      } else {
        console.error(`QB Error for entry: ${statusCode} - ${statusMessage}`);
        session.lastError = statusMessage;
      }
    }

    // Move to next entry
    session.currentIndex++;

    // Calculate progress percentage
    const progress = Math.floor((session.currentIndex / session.pendingEntries.length) * 100);

    return buildResponse('receiveResponseXMLResponse', { receiveResponseXMLResult: progress });
  } catch (error) {
    console.error('Error parsing QB response:', error);
    session.lastError = error.message;
    session.currentIndex++;
    return buildResponse('receiveResponseXMLResponse', { receiveResponseXMLResult: -1 });
  }
}

/**
 * Handle connectionError
 */
function handleConnectionError(params) {
  const ticket = params.ticket || '';
  const message = params.message || '';

  console.error(`Connection error for ${ticket}: ${message}`);

  const session = sessions.get(ticket);
  if (session) {
    session.lastError = message;
  }

  return buildResponse('connectionErrorResponse', { connectionErrorResult: 'done' });
}

/**
 * Handle getLastError
 */
function handleGetLastError(params) {
  const ticket = params.ticket || '';
  const session = sessions.get(ticket);
  const lastError = session?.lastError || '';

  return buildResponse('getLastErrorResponse', { getLastErrorResult: lastError });
}

/**
 * Handle closeConnection
 */
function handleCloseConnection(params) {
  const ticket = params.ticket || '';

  console.log(`Closing connection for ticket: ${ticket}`);
  sessions.delete(ticket);

  return buildResponse('closeConnectionResponse', { closeConnectionResult: 'OK' });
}

/**
 * Build SOAP response envelope
 */
function buildResponse(methodName, result) {
  const builder = new Builder({
    headless: true,
    renderOpts: { pretty: true }
  });

  const responseObj = {
    'soap:Envelope': {
      $: {
        'xmlns:soap': 'http://schemas.xmlsoap.org/soap/envelope/',
        'xmlns:qbwc': 'http://developer.intuit.com/'
      },
      'soap:Body': {
        [`qbwc:${methodName}`]: result
      }
    }
  };

  return '<?xml version="1.0" encoding="utf-8"?>' + builder.buildObject(responseObj);
}

/**
 * Build SOAP fault response
 */
function buildSOAPFault(message) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Server</faultcode>
      <faultstring>${message}</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
}

/**
 * Return WSDL for Web Connector
 */
function getWSDL() {
  return `<?xml version="1.0" encoding="utf-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
             xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
             xmlns:tns="http://developer.intuit.com/"
             xmlns:s="http://www.w3.org/2001/XMLSchema"
             targetNamespace="http://developer.intuit.com/"
             name="QBWebConnectorSvc">

  <types>
    <s:schema targetNamespace="http://developer.intuit.com/">
      <s:element name="serverVersion">
        <s:complexType/>
      </s:element>
      <s:element name="serverVersionResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="serverVersionResult" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:element name="clientVersion">
        <s:complexType>
          <s:sequence>
            <s:element name="strVersion" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="clientVersionResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="clientVersionResult" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:element name="authenticate">
        <s:complexType>
          <s:sequence>
            <s:element name="strUserName" type="s:string"/>
            <s:element name="strPassword" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="authenticateResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="authenticateResult" type="tns:ArrayOfString"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:complexType name="ArrayOfString">
        <s:sequence>
          <s:element name="string" type="s:string" maxOccurs="unbounded"/>
        </s:sequence>
      </s:complexType>

      <s:element name="sendRequestXML">
        <s:complexType>
          <s:sequence>
            <s:element name="ticket" type="s:string"/>
            <s:element name="strHCPResponse" type="s:string"/>
            <s:element name="strCompanyFileName" type="s:string"/>
            <s:element name="qbXMLCountry" type="s:string"/>
            <s:element name="qbXMLMajorVers" type="s:int"/>
            <s:element name="qbXMLMinorVers" type="s:int"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="sendRequestXMLResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="sendRequestXMLResult" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:element name="receiveResponseXML">
        <s:complexType>
          <s:sequence>
            <s:element name="ticket" type="s:string"/>
            <s:element name="response" type="s:string"/>
            <s:element name="hresult" type="s:string"/>
            <s:element name="message" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="receiveResponseXMLResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="receiveResponseXMLResult" type="s:int"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:element name="connectionError">
        <s:complexType>
          <s:sequence>
            <s:element name="ticket" type="s:string"/>
            <s:element name="hresult" type="s:string"/>
            <s:element name="message" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="connectionErrorResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="connectionErrorResult" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:element name="getLastError">
        <s:complexType>
          <s:sequence>
            <s:element name="ticket" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="getLastErrorResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="getLastErrorResult" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>

      <s:element name="closeConnection">
        <s:complexType>
          <s:sequence>
            <s:element name="ticket" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
      <s:element name="closeConnectionResponse">
        <s:complexType>
          <s:sequence>
            <s:element name="closeConnectionResult" type="s:string"/>
          </s:sequence>
        </s:complexType>
      </s:element>
    </s:schema>
  </types>

  <message name="serverVersionSoapIn"><part name="parameters" element="tns:serverVersion"/></message>
  <message name="serverVersionSoapOut"><part name="parameters" element="tns:serverVersionResponse"/></message>
  <message name="clientVersionSoapIn"><part name="parameters" element="tns:clientVersion"/></message>
  <message name="clientVersionSoapOut"><part name="parameters" element="tns:clientVersionResponse"/></message>
  <message name="authenticateSoapIn"><part name="parameters" element="tns:authenticate"/></message>
  <message name="authenticateSoapOut"><part name="parameters" element="tns:authenticateResponse"/></message>
  <message name="sendRequestXMLSoapIn"><part name="parameters" element="tns:sendRequestXML"/></message>
  <message name="sendRequestXMLSoapOut"><part name="parameters" element="tns:sendRequestXMLResponse"/></message>
  <message name="receiveResponseXMLSoapIn"><part name="parameters" element="tns:receiveResponseXML"/></message>
  <message name="receiveResponseXMLSoapOut"><part name="parameters" element="tns:receiveResponseXMLResponse"/></message>
  <message name="connectionErrorSoapIn"><part name="parameters" element="tns:connectionError"/></message>
  <message name="connectionErrorSoapOut"><part name="parameters" element="tns:connectionErrorResponse"/></message>
  <message name="getLastErrorSoapIn"><part name="parameters" element="tns:getLastError"/></message>
  <message name="getLastErrorSoapOut"><part name="parameters" element="tns:getLastErrorResponse"/></message>
  <message name="closeConnectionSoapIn"><part name="parameters" element="tns:closeConnection"/></message>
  <message name="closeConnectionSoapOut"><part name="parameters" element="tns:closeConnectionResponse"/></message>

  <portType name="QBWebConnectorSvcSoap">
    <operation name="serverVersion"><input message="tns:serverVersionSoapIn"/><output message="tns:serverVersionSoapOut"/></operation>
    <operation name="clientVersion"><input message="tns:clientVersionSoapIn"/><output message="tns:clientVersionSoapOut"/></operation>
    <operation name="authenticate"><input message="tns:authenticateSoapIn"/><output message="tns:authenticateSoapOut"/></operation>
    <operation name="sendRequestXML"><input message="tns:sendRequestXMLSoapIn"/><output message="tns:sendRequestXMLSoapOut"/></operation>
    <operation name="receiveResponseXML"><input message="tns:receiveResponseXMLSoapIn"/><output message="tns:receiveResponseXMLSoapOut"/></operation>
    <operation name="connectionError"><input message="tns:connectionErrorSoapIn"/><output message="tns:connectionErrorSoapOut"/></operation>
    <operation name="getLastError"><input message="tns:getLastErrorSoapIn"/><output message="tns:getLastErrorSoapOut"/></operation>
    <operation name="closeConnection"><input message="tns:closeConnectionSoapIn"/><output message="tns:closeConnectionSoapOut"/></operation>
  </portType>

  <binding name="QBWebConnectorSvcSoap" type="tns:QBWebConnectorSvcSoap">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="serverVersion"><soap:operation soapAction="http://developer.intuit.com/serverVersion"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="clientVersion"><soap:operation soapAction="http://developer.intuit.com/clientVersion"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="authenticate"><soap:operation soapAction="http://developer.intuit.com/authenticate"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="sendRequestXML"><soap:operation soapAction="http://developer.intuit.com/sendRequestXML"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="receiveResponseXML"><soap:operation soapAction="http://developer.intuit.com/receiveResponseXML"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="connectionError"><soap:operation soapAction="http://developer.intuit.com/connectionError"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="getLastError"><soap:operation soapAction="http://developer.intuit.com/getLastError"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="closeConnection"><soap:operation soapAction="http://developer.intuit.com/closeConnection"/><input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
  </binding>

  <service name="QBWebConnectorSvc">
    <port name="QBWebConnectorSvcSoap" binding="tns:QBWebConnectorSvcSoap">
      <soap:address location="https://qbwc-bridge-pn62.onrender.com/qbwc"/>
    </port>
  </service>
</definitions>`;
}
