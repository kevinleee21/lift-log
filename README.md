# Lift Log

A personal workout tracker that runs as a phone app (PWA). It costs $0 to run and stores everything in your own Google Sheet.

| File | What it is |
|---|---|
| `index.html` | App shell + styles |
| `app.js` | All app logic. Trend thresholds live in `CONFIG` at the top |
| `sw.js`, `manifest.json`, icons | Makes it installable and work offline |
| `apps-script/Code.gs` | Backend: paste into the Sheet's Apps Script editor |

## Setup

### 1. Create the Sheet
1. Go to <https://sheets.new>.
2. Click "Untitled spreadsheet" and rename it to **Workout Log**.

### 2. Add the backend
1. In the Sheet: **Extensions → Apps Script**.
2. Delete everything in `Code.gs`, paste in the contents of `apps-script/Code.gs`, and press **⌘S**.
3. In the toolbar's function dropdown, pick **setup** and click **Run**.
4. Click **Review permissions**, choose your account, then **Advanced → Go to … (unsafe) → Allow**. This is your own script, so it's safe.
5. The **Execution log** shows `Your API token is: …`. Copy the token.

### 3. Deploy it as a web app
1. **Deploy → New deployment**, click the gear, then choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**. Your token protects your data.
3. Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).

### 4. Connect the app
Open the app, go to **Settings**, paste the URL and token, then tap **Save & test connection**.

### 5. Add to your iPhone home screen
1. Open the app's URL in **Safari**. It has to be Safari.
2. Tap the **Share** button (square with an up arrow), then **Add to Home Screen**, then **Add**.

## Changing the backend later
After you edit `Code.gs`: **Deploy → Manage deployments**, click the pencil, set **Version: New version**, then **Deploy**. The URL stays the same.

## Changing the frontend later
Bump `VERSION` in `sw.js` so phones pick up the new files.
