# Asset Tracker

A web app for an IT team to track computers, monitors, phones, TVs, tablets, servers, switches and anything else with an asset tag. It runs on one machine on your network. Everyone else uses it in a browser, on a desktop or a phone.

## What it does

- **Scanning**
  - **USB or Bluetooth barcode scanners** work on any page, whether or not a box is selected.
  - **Phone cameras** scan live, with a beep on each read.
  - **Photo** decodes a barcode from a picture you take.
  - A scan matches the asset tag, serial number, IMEI or MAC address. A code that isn't in the register starts a new asset.
- **Device-specific fields:**
  - Computers and network gear: hostname, IP and MAC address.
  - Phones and tablets: IMEI, phone number and carrier.
  - Displays: screen size.
  - Every category is linked to one of these device types. Administrators can add categories.
- **Check out, check in, repair, missing, retire, dispose.** Each change is written to the asset's history with who made it and when.
- **Audits:** pick a room, turn on Audit mode and scan everything in it. You see what's missing from the room and anything found there that the register had somewhere else. Assets nobody scanned can be marked missing in one step.
- **Labels:** Code 128 barcode labels, printed one per page for Dymo, Zebra or Brother label printers. Print one label, or a label for every asset in the current list.
- **CSV import and export:**
  - Import recognises common column names ("Asset Tag", "Serial Number", "Assigned To" and so on).
  - Re-importing updates existing assets instead of duplicating them.
- **Team use:**
  - Sign-in accounts with three roles: Viewer, Technician and Administrator.
  - Everyone's screen updates live when someone makes a change.
  - If two people edit the same asset at once, the second save is stopped instead of overwriting the first.

## Requirements

- Node.js 22.16 or newer. Node 24 LTS is recommended.
- No separate database server. Data is stored in a single SQLite file, `data/assets.db`.

## Start it

```powershell
cd C:\Users\Shannon\asset-tracker
npm install
npm start
```

1. Open http://localhost:3000.
2. The first visit asks you to create the administrator account.
3. Add the rest of the team under **Admin → Team members**.

To change the port, label header, tag format or data folder, copy `.env.example` to `.env` and edit it.

### Roles

| Role | Can |
| --- | --- |
| Viewer | Look up and search assets, export CSV, print labels |
| Technician | Everything a viewer can, plus add, edit, scan, check out, audit and import |
| Administrator | Everything, plus manage team members and categories, and delete assets |

## Barcode scanners

- Most USB and Bluetooth scanners act as a keyboard: they type the code and then press Enter. That works with no setup. Leave the scanner in its default "keyboard" (HID) mode with an Enter suffix.
- While an asset is open, a scan types into whichever field is selected. Pressing Enter moves to the next field instead of saving, so you can scan a serial number straight into the form.

## Phones and HTTPS

Phone browsers only allow live camera access on HTTPS pages or on `localhost`. Over plain `http://192.168.x.x:3000`, the **Camera** button falls back to taking a photo, which still works.

To get live camera scanning, give the server a certificate the phones trust. Use one of these two options:

**Option 1: your own certificate with mkcert** (simplest on a private network)

1. Install [mkcert](https://github.com/FiloSottile/mkcert). Run `mkcert -install`, then `mkcert -cert-file certs/server.pem -key-file certs/server-key.pem assets.yourcompany.local 192.168.1.50`. Use your server's real name and IP address.
2. Set `HTTPS_CERT=./certs/server.pem` and `HTTPS_KEY=./certs/server-key.pem` in `.env`. The server then listens on port 3443.
3. Install mkcert's root certificate on each phone:
   - Its location is shown by `mkcert -CAROOT`.
   - On an iPhone, also turn it on under Settings → General → About → Certificate Trust Settings.

**Option 2: a reverse proxy.** Put the app behind IIS, nginx or Caddy using a certificate your devices already trust, such as your company's internal certificate authority or a public certificate. Set `TRUST_PROXY=1` and `SECURE_COOKIES=1` in `.env`.

## Labels

- Open an asset and choose **Print label**. To print labels for many assets, filter the list and choose **Print labels** above it.
- Pick the label size that matches your roll. In the print dialog, choose the label printer and set margins to none.
- Labels are generated at 300 dpi. Code 128 can't encode characters outside basic ASCII, so keep tags to letters, numbers and dashes.

## CSV import

- The only required column is **Asset tag**.
- Other columns are matched by name. The easiest way to see the expected headers is to export first.
- Status values such as "deployed", "spare", "broken" or "stolen" are converted to the app's statuses.
- Dates can be `2024-03-15` or `3/15/2024`.
- Unknown categories are created automatically. Check their device type under Admin afterwards.
- Blank cells never erase existing values.
- Rows with problems are skipped and listed when the import finishes.

## Backups

```powershell
npm run backup                    # writes data\backups\assets-<date>.db
npm run backup -- D:\Backups      # or choose a folder
```

- This is safe while the server is running.
- To schedule it, use Windows Task Scheduler.
- To restore, stop the server and copy a backup over `data\assets.db`.

## Keep it running on a Windows server

- Run `npm start` from a service manager so it starts at boot and restarts if it stops. [NSSM](https://nssm.cc/) works well: `nssm install AssetTracker "C:\Program Files\nodejs\node.exe" "--env-file-if-exists=.env src\server.js"`, with the app folder as the startup directory.
- Open the port in Windows Firewall for your internal network only. This app is meant for a private network, not the public internet.

## Development

```powershell
npm run dev    # restarts on file changes
npm test       # API tests against an in-memory database
```

| Path | Contents |
| --- | --- |
| `src/server.js` | Startup, HTTP/HTTPS |
| `src/app.js` | Express app, security headers |
| `src/db.js` | Schema, migrations, statuses, field list |
| `src/assets.js` | Asset rules: validation, history, lookups |
| `src/csv.js` | CSV parsing, import and export |
| `src/auth.js` | Passwords (scrypt), sessions, roles |
| `src/routes/` | API endpoints |
| `public/` | The browser app; `scanner.js` handles camera and photo decoding |

- **Adding a field:** add a column in a new entry in `MIGRATIONS` (`src/db.js`) and an entry in `FIELDS`. The form, CSV import and CSV export all pick it up from there.
- **Security:**
  - Passwords are hashed with scrypt.
  - Sessions use HTTP-only cookies.
  - Every write request must carry an `X-Requested-With` header, which blocks cross-site request forgery.
  - Ten failed sign-ins on one username lock it for 15 minutes.
