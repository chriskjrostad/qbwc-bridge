/**
 * Google Apps Script API wrapper for QBWC Bridge
 *
 * Calls the Apps Script web app endpoints to read/write clock data.
 * This avoids the need for service account keys.
 */

// Configuration - set via environment variables
const CONFIG = {
  // Apps Script web app URL (deployed as "Execute as: Me", "Who has access: Anyone")
  appsScriptUrl: process.env.APPS_SCRIPT_URL || '',
  // API secret for authentication
  apiSecret: process.env.QBWC_API_SECRET || 'TrippInQB2026!'
};

/**
 * Get clock entries that need to be synced to QuickBooks
 * Calls the Apps Script ?action=qbpending endpoint
 * @returns {Promise<Array>} Array of pending entries
 */
async function getQBSyncPendingEntries() {
  if (!CONFIG.appsScriptUrl) {
    throw new Error('APPS_SCRIPT_URL environment variable not set');
  }

  const url = `${CONFIG.appsScriptUrl}?action=qbpending&secret=${encodeURIComponent(CONFIG.apiSecret)}`;

  console.log('Fetching pending entries from Apps Script...');

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Apps Script returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.error || 'Unknown error from Apps Script');
  }

  console.log(`Apps Script returned ${result.entries?.length || 0} pending entries`);
  return result.entries || [];
}

/**
 * Mark entries as synced to QuickBooks
 * Calls the Apps Script ?action=qbmarksync endpoint
 * @param {string[]} entryIds - Array of entry IDs to mark as synced
 */
async function markEntriesQBSynced(entryIds) {
  if (!CONFIG.appsScriptUrl || !entryIds || entryIds.length === 0) {
    return;
  }

  const url = `${CONFIG.appsScriptUrl}?action=qbmarksync&secret=${encodeURIComponent(CONFIG.apiSecret)}&ids=${encodeURIComponent(entryIds.join(','))}`;

  console.log(`Marking ${entryIds.length} entries as synced...`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Apps Script returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();

  if (!result.ok) {
    throw new Error(result.error || 'Failed to mark entries as synced');
  }

  console.log(`Successfully marked ${result.count || 0} entries as QB synced`);
}

module.exports = {
  getQBSyncPendingEntries,
  markEntriesQBSynced
};
