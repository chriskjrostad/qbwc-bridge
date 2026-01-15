/**
 * Simple HTTP server wrapper for Render.com deployment
 */

const http = require('http');
const { qbwcHandler } = require('./index');

const PORT = process.env.PORT || 3000;

// Create a simple request/response adapter
const server = http.createServer(async (req, res) => {
  // Collect body
  let body = '';
  req.on('data', chunk => { body += chunk; });

  req.on('end', async () => {
    // Create a mock request object similar to Cloud Functions
    const mockReq = {
      method: req.method,
      url: req.url,
      query: parseQuery(req.url),
      body: body,
      headers: req.headers
    };

    // Create a mock response object
    const mockRes = {
      statusCode: 200,
      headers: {},
      body: '',
      status: function(code) { this.statusCode = code; return this; },
      set: function(key, value) { this.headers[key] = value; return this; },
      send: function(data) {
        this.body = data;
        res.writeHead(this.statusCode, this.headers);
        res.end(this.body);
      }
    };

    try {
      await qbwcHandler(mockReq, mockRes);
    } catch (error) {
      console.error('Handler error:', error);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });
});

function parseQuery(url) {
  const query = {};
  const queryStart = url.indexOf('?');
  if (queryStart !== -1) {
    const queryString = url.slice(queryStart + 1);
    queryString.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      query[decodeURIComponent(key)] = value !== undefined ? decodeURIComponent(value) : '';
    });
  }
  return query;
}

server.listen(PORT, () => {
  console.log(`QBWC Bridge server running on port ${PORT}`);
});
