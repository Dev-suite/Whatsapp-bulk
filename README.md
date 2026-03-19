# WhatsApp Bulk Dashboard

## Setup
1. Extract the project
2. Run:
   npm install

3. Rename `.env.example` to `.env` and add:
   - ACCESS_TOKEN
   - PHONE_NUMBER_ID

4. Start:
   npm start

5. Open:
   http://localhost:3000

## CSV format
name,phone
John,08143026332
Mary,2349040931311

## Webhook
- GET /webhook for verification
- POST /webhook for incoming messages and status updates

Current verify token in `server.js`:
`my_verify_token`

## Notes
- This MVP uses in-memory storage only
- If server restarts, logs are cleared
- Use a direct public .mp4 link for the video header
