

[README.md](https://github.com/user-attachments/files/34384166/README.md)
# Milk ATM — STK Push setup guide

## What changed

The customer now types their own phone number on the keypad, gets an M-Pesa
prompt on their handset, enters their **M-Pesa PIN**, and the machine dispenses
by itself. No attendant, no SMS reading, no transaction codes.

```
  Customer phone  <--- STK prompt ---  Safaricom
        |                                  ^
        | enters PIN                       | HTTPS (Daraja)
        v                                  |
                              Your VPS (server/index.js)
                                           ^
                                           | HTTPS + api key
                                      ESP32 bridge
                                           ^
                                           | UART
                                    Arduino MEGA (this machine)
```

## Why you cannot skip the server

Two hard constraints, both from Safaricom's side:

1. **Daraja requires TLS 1.2.** The SIM800L's TLS stack is too old. It
   physically cannot complete the handshake with `api.safaricom.co.ke`.
2. **Daraja delivers the payment result to a callback URL.** That URL has to
   be a public HTTPS address. An Arduino behind a SIM card has no such address.

A third reason is yours, not Safaricom's: your consumer secret and passkey must
never live inside a box a customer can unscrew.

---

## Hardware to buy

| Item | Notes |
|---|---|
| ESP32 DevKit v1 (or WROOM-32) | the TLS-capable network board |
| 5V 2A supply for the ESP32 | do **not** power it from the Mega's 5V pin |
| Bi-directional level shifter (4-ch) | for the Mega↔ESP32 UART |
| WiFi source | shop router, or a 4G router / MiFi with a data SIM |
| (optional) SIM7600E-H module | only if there is no WiFi at all — see below |

Keep the SIM800L. It still does the admin SMS commands, the daily report, and
the offline fallback payment path.

### Wiring: Mega ↔ ESP32

```
MEGA TX2 (pin 16) --[1k]--+--> ESP32 GPIO16 (RX2)
                          |
                        [2k]
                          |
                         GND

ESP32 GPIO17 (TX2) ------> MEGA RX2 (pin 17)      (3.3V into a 5V input works)

MEGA GND ----------------- ESP32 GND              (mandatory)
```

The divider on the Mega→ESP32 line is not optional. 5V straight into an ESP32
GPIO will kill the pin, usually not immediately, which makes it worse to debug.

### If there is no WiFi

Swap the ESP32's WiFi for a **SIM7600E-H** (LTE Cat-1, supports TLS 1.2) driven
by the same ESP32 over its second UART. Only `apiCall()` in the bridge sketch
changes — the UART protocol to the Mega stays identical. Budget for a data SIM
with a small monthly bundle; each transaction is a few kilobytes.

---

## Software setup

### 1. Daraja account

1. Register at `developer.safaricom.co.ke`.
2. Create an app, tick the M-Pesa Express (Lipa na M-Pesa Online) product.
3. Copy the **Consumer Key** and **Consumer Secret**.
4. For sandbox testing use the test shortcode and passkey from the portal's
   test credentials page.
5. For production you need a real **Paybill or Till** and must apply for
   go-live. Safaricom will ask for business registration documents and the
   production shortcode + passkey are issued after approval. Expect this to
   take days, not minutes — build and test on sandbox first.

Paybill vs Till in `.env`:

- **Paybill:** `SHORTCODE` = paybill, `PARTY_B` blank,
  `TRANSACTION_TYPE=CustomerPayBillOnline`
- **Till:** `SHORTCODE` = head office / store number, `PARTY_B` = the till
  number, `TRANSACTION_TYPE=CustomerBuyGoodsOnline`

### 2. Server

Any small VPS works (a 1 GB droplet is plenty).

```bash
cd server
cp .env.example .env      # fill it in
npm install
npm start
```

Put it behind HTTPS. Caddy is the least painful:

```
mpesa.yourdomain.co.ke {
    reverse_proxy localhost:3000
}
```

Caddy fetches the certificate itself. Then check:

```bash
curl https://mpesa.yourdomain.co.ke/health
```

Use `pm2 start index.js --name milkatm` or a systemd unit so it survives a
reboot.

Generate your secrets:

```bash
openssl rand -hex 16    # CALLBACK_TOKEN
openssl rand -hex 24    # device API key
```

### 3. ESP32

Arduino IDE → Boards Manager → **esp32** by Espressif. Library Manager →
**ArduinoJson** (v7). Edit the four constants at the top of
`ESP32_Bridge.ino`, flash it, open the serial monitor at 115200 and confirm
WiFi connects.

### 4. Mega

Flash `MilkATM_Mega_v4.ino`. The EEPROM magic changed from v3, so the setup
wizard runs again on first boot — that is deliberate, since the report hour is
new. Your cards survive; the wizard does not touch them.

---

## Testing order

Test each link separately. Debugging all three at once is miserable.

1. **Server alone.** With the machine off:
   ```bash
   curl -X POST https://mpesa.yourdomain.co.ke/api/stk \
     -H "x-api-key: YOUR_DEVICE_KEY" -H "Content-Type: application/json" \
     -d '{"phone":"254712345678","amount":1,"ref":"TEST"}'
   ```
   You should get `{"ok":true,"txn":"AB12CD34"}` and a prompt on the phone.
   Then poll `GET /api/status/AB12CD34`.

2. **ESP32 alone.** Open its serial monitor, and from a USB-serial adapter on
   GPIO16/17 send `NET?` then `STK 254712345678 1 TEST`.

3. **Whole machine.** Buy → 3 → 1, enter a number, pay 1 shilling.

Sandbox test numbers only ever return success. Test cancellation and timeout
behaviour on production with 1-shilling transactions before you let customers
near it.

---

## What the customer sees

```
1:Cash 2:Card          ->   Your M-Pesa No:      ->  KSh 50 = 714ml
3:M-Pesa *:Back             0712345678               # OK   * Cancel

     ->  Contacting M-Pesa   ->  Check your phone   ->  PAID KSh 50
                                 Enter M-Pesa PIN       SFT4K2L9XZ

                            ->  Dispensing...
```

Failure messages are specific, because "payment failed" makes customers argue:
cancelled (1032), no response from phone (1037), wrong PIN (2001), insufficient
balance (1).

---

## Daily report

At the hour set in the wizard (default 20:00) the machine texts the admin
phone:

```
Milk ATM 30/08: 24 sales, 41.20 L, KSh 2884.00. Card float KSh 1250.00.
```

Change it with `<PIN> REPORT 19` by SMS, or Manager → 4 → B → 3.
Ask for the running total any time with `<PIN> SALES`.
Totals reset at midnight; if the machine was off at the report hour, the
previous day is flushed when it next notices the date changed.

---

## Known limits

- Pending transactions live in the server's memory. Restart the server
  mid-payment and that one customer's transaction is lost (their money is not
  — it is in your till, but the machine will not know). Move to SQLite before
  you run more than one machine.
- The machine dispenses **after** payment succeeds. If the flow sensor fails at
  that moment, the customer has paid and got nothing. The code texts you, but
  the refund is manual. This is the single most important failure mode to have
  a shop policy for.
- `tls.setInsecure()` on the ESP32 encrypts but does not verify the server's
  identity. Fine on your own router; pin the root CA before deploying on
  public WiFi.
