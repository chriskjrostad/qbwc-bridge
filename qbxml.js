/**
 * QBXML Builder for QuickBooks Time Tracking
 *
 * Builds QBXML messages for adding time tracking entries to QuickBooks.
 */

/**
 * Build QBXML TimeTrackingAdd request
 * @param {Object} entry - Clock entry from Google Sheets
 * @returns {string} QBXML request
 */
function buildTimeTrackingAddXML(entry) {
  // Parse dates
  const clockIn = new Date(entry.ClockIn);
  const clockOut = entry.ClockOut ? new Date(entry.ClockOut) : null;

  // Format date as YYYY-MM-DD
  const txnDate = formatDate(clockIn);

  // Calculate duration in ISO 8601 format (PT#H#M)
  const totalHours = parseFloat(entry.TotalHours) || 0;
  const duration = formatDuration(totalHours);

  // Employee name - must match exactly with QuickBooks
  const employeeName = escapeXml(entry.EmployeeName || 'Unknown');

  // Build notes with job info
  let notes = [];
  if (entry.CustomerName && entry.CustomerName !== 'Shop') {
    notes.push(`Customer: ${entry.CustomerName}`);
  }
  if (entry.JobName) {
    notes.push(`Job: ${entry.JobName}`);
  }
  if (entry.Notes) {
    notes.push(`Notes: ${entry.Notes}`);
  }
  const notesText = escapeXml(notes.join(' | '));

  // Build QBXML
  let qbxml = `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <TimeTrackingAddRq>
      <TimeTrackingAdd>
        <TxnDate>${txnDate}</TxnDate>
        <EntityRef>
          <FullName>${employeeName}</FullName>
        </EntityRef>
        <Duration>${duration}</Duration>`;

  // Add customer reference if billable
  if (entry.CustomerName && entry.CustomerName !== 'Shop' && entry.RequiresTicket === 'TRUE') {
    qbxml += `
        <CustomerRef>
          <FullName>${escapeXml(entry.CustomerName)}</FullName>
        </CustomerRef>
        <BillableStatus>Billable</BillableStatus>`;
  } else {
    qbxml += `
        <BillableStatus>NotBillable</BillableStatus>`;
  }

  // Add notes if present
  if (notesText) {
    qbxml += `
        <Notes>${notesText}</Notes>`;
  }

  qbxml += `
      </TimeTrackingAdd>
    </TimeTrackingAddRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxml;
}

/**
 * Format date as YYYY-MM-DD
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Format hours as ISO 8601 duration (PT#H#M)
 * @param {number} hours - Decimal hours
 * @returns {string} ISO 8601 duration
 */
function formatDuration(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;

  if (m === 0) {
    return `PT${h}H`;
  }
  return `PT${h}H${m}M`;
}

/**
 * Escape XML special characters
 */
function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  buildTimeTrackingAddXML,
  formatDate,
  formatDuration,
  escapeXml
};
