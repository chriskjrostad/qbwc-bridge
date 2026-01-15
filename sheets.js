/**
 * Google Sheets API wrapper for QBWC Bridge
 *
 * Reads clock entries from the Roster spreadsheet's ClockLog sheet
 * and marks entries as synced after successful QB import.
 */

const { google } = require('googleapis');

// Configuration - set via environment variables
const CONFIG = {
  spreadsheetId: process.env.ROSTER_SHEET_ID || '',
  clockLogSheet: 'ClockLog',
  // Column indices (0-based) - update if sheet structure changes
  columns: {
    ID: 0,
    EmployeeId: 1,
    EmployeeName: 2,
    ClockIn: 3,
    ClockOut: 4,
    RequiresTicket: 5,
    TicketId: 6,
    TicketHeaderId: 7,
    TicketLineId: 8,
    CustomerId: 9,
    CustomerName: 10,
    JobId: 11,
    JobName: 12,
    ShopHours: 13,
    OtherHours: 14,
    TotalHours: 15,
    Status: 16,
    Notes: 17,
    CreatedAt: 18,
    UpdatedAt: 19,
    QBSynced: 20  // New column we'll add
  }
};

let sheetsClient = null;

/**
 * Get authenticated Sheets API client
 */
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  let authClient;

  // Check for service account credentials in environment variable
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    authClient = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    // Fall back to Application Default Credentials (works on GCP)
    authClient = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  }

  const client = await authClient.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });

  return sheetsClient;
}

/**
 * Get clock entries that need to be synced to QuickBooks
 * Returns entries where Status = 'COMPLETE' and QBSynced != 'TRUE'
 */
async function getQBSyncPendingEntries() {
  if (!CONFIG.spreadsheetId) {
    throw new Error('ROSTER_SHEET_ID environment variable not set');
  }

  const sheets = await getSheetsClient();

  // Read all data from ClockLog
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${CONFIG.clockLogSheet}!A:U`,  // A through U (21 columns)
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING'
  });

  const rows = response.data.values || [];
  if (rows.length <= 1) {
    return [];  // Only header row or empty
  }

  const headers = rows[0];
  const pendingEntries = [];

  // Find QBSynced column index (might not exist yet)
  let qbSyncedIdx = headers.indexOf('QBSynced');

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    // Build entry object
    const entry = {};
    for (let j = 0; j < headers.length; j++) {
      entry[headers[j]] = row[j] || '';
    }
    entry._rowIndex = i + 1;  // 1-based row number for updates

    // Check if entry needs sync:
    // - Status = 'COMPLETE'
    // - QBSynced != 'TRUE'
    const status = String(entry.Status || '').toUpperCase();
    const qbSynced = String(entry.QBSynced || '').toUpperCase();

    if (status === 'COMPLETE' && qbSynced !== 'TRUE') {
      // Validate required fields
      if (entry.EmployeeName && entry.TotalHours) {
        pendingEntries.push(entry);
      }
    }
  }

  console.log(`Found ${pendingEntries.length} pending entries out of ${rows.length - 1} total`);
  return pendingEntries;
}

/**
 * Mark entries as synced to QuickBooks
 * Sets QBSynced = 'TRUE' for the given entry IDs
 */
async function markEntriesQBSynced(entryIds) {
  if (!CONFIG.spreadsheetId || !entryIds || entryIds.length === 0) {
    return;
  }

  const sheets = await getSheetsClient();

  // First, ensure QBSynced column exists
  await ensureQBSyncedColumn(sheets);

  // Get current data to find row indices
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${CONFIG.clockLogSheet}!A:U`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });

  const rows = response.data.values || [];
  const headers = rows[0] || [];
  const idIdx = headers.indexOf('ID');
  const qbSyncedIdx = headers.indexOf('QBSynced');

  if (idIdx === -1 || qbSyncedIdx === -1) {
    throw new Error('Required columns not found');
  }

  // Prepare batch update
  const updates = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowId = String(row[idIdx] || '');

    if (entryIds.includes(rowId)) {
      // Column letter for QBSynced (A=1, B=2, ... U=21)
      const colLetter = String.fromCharCode(65 + qbSyncedIdx);
      updates.push({
        range: `${CONFIG.clockLogSheet}!${colLetter}${i + 1}`,
        values: [['TRUE']]
      });
    }
  }

  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: CONFIG.spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates
      }
    });
    console.log(`Marked ${updates.length} entries as QB synced`);
  }
}

/**
 * Ensure QBSynced column exists in ClockLog sheet
 */
async function ensureQBSyncedColumn(sheets) {
  // Get headers
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.spreadsheetId,
    range: `${CONFIG.clockLogSheet}!1:1`
  });

  const headers = response.data.values?.[0] || [];

  if (!headers.includes('QBSynced')) {
    // Add QBSynced header to next available column
    const nextCol = String.fromCharCode(65 + headers.length);  // A=0, B=1, ...

    await sheets.spreadsheets.values.update({
      spreadsheetId: CONFIG.spreadsheetId,
      range: `${CONFIG.clockLogSheet}!${nextCol}1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [['QBSynced']]
      }
    });
    console.log(`Added QBSynced column at ${nextCol}`);
  }
}

module.exports = {
  getQBSyncPendingEntries,
  markEntriesQBSynced,
  ensureQBSyncedColumn
};
