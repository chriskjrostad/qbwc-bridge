# QuickBooks Web Connector Bridge

This Google Cloud Function acts as a SOAP bridge between the Tripp In maintenance portal and QuickBooks Desktop Pro.

## How It Works

1. QuickBooks Web Connector (on biller's PC) polls this service
2. Service reads pending clock entries from Google Sheets
3. Converts to QBXML TimeTracking format
4. Web Connector imports into QuickBooks
5. Service marks entries as synced

## Deployment

### Prerequisites

1. Google Cloud SDK installed (`gcloud`)
2. Access to the GCP project `tripp-in-suite-apps-script`
3. Cloud Functions API enabled

### Steps

1. Set environment variables:
   ```bash
   # Get your Roster spreadsheet ID from the URL
   export ROSTER_SHEET_ID="your-spreadsheet-id"
   export QBWC_PASSWORD="your-secure-password"
   ```

2. Deploy the function:
   ```bash
   cd qbwc-bridge
   gcloud functions deploy qbwc-bridge \
     --runtime nodejs18 \
     --trigger-http \
     --allow-unauthenticated \
     --entry-point=qbwcHandler \
     --set-env-vars ROSTER_SHEET_ID=$ROSTER_SHEET_ID,QBWC_PASSWORD=$QBWC_PASSWORD \
     --project tripp-in-suite-apps-script
   ```

3. Get the function URL from the output (looks like `https://REGION-PROJECT.cloudfunctions.net/qbwc-bridge`)

4. Update `trippin-qbwc.qwc` with the actual URL

## Biller Setup

1. Download QuickBooks Web Connector from Intuit
2. Open Web Connector
3. Click "Add an Application"
4. Load `trippin-qbwc.qwc` file
5. Enter the password when prompted
6. Authorize access to QuickBooks company file
7. Click "Update Selected" to run first sync

## Data Flow

```
ClockLog (Google Sheets)
    ↓
[Status = COMPLETE, QBSynced != TRUE]
    ↓
Cloud Function (QBXML)
    ↓
Web Connector (SOAP)
    ↓
QuickBooks Time Tracking
    ↓
[Mark QBSynced = TRUE]
```

## Troubleshooting

- **Auth failed**: Check username/password match in .qwc and environment
- **No entries syncing**: Verify clock entries have Status=COMPLETE
- **Employee not found**: Employee names must match exactly between portal and QB
- **View logs**: `gcloud functions logs read qbwc-bridge --project tripp-in-suite-apps-script`
