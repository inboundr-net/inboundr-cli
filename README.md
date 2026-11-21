# Inboundr CLI

The command line for [Inboundr](https://inboundr.net). Forward inbound email to
your local server as signed webhook deliveries, and read, reply to and send
email from your terminal.

```bash
npm install -g @inboundr/cli
# or, without installing
npx @inboundr/cli --help
```

Node.js 20 or later.

## Log in

```bash
inboundr login
```

Paste an API key from the console (**API keys**). It's checked, then saved to
`~/.config/inboundr/config.json`, readable only by you. `INBOUNDR_API_KEY` or
`--api-key` take precedence over the saved key. `inboundr status` shows which
key is in use.

In CI, pipe it in: `inboundr login --with-token < key.txt`, or just set
`INBOUNDR_API_KEY`.

## Receive email on localhost

```bash
inboundr listen --forward-to localhost:3000/inbound
```

```
Ready. Forwarding new inbound email to http://localhost:3000/inbound
Webhook secret: whsec_… (set it as INBOUNDR_WEBHOOK_SECRET in your app)

14:02:11  em_8x2k…  jane@example.com  Where is my order?  →  [204] 34 ms
```

Each new inbound email is POSTed to your URL exactly as a real delivery: the
same JSON body, the same `x-inboundr-*` headers, signed with the secret shown.
Verification code written for production, such as the SDKs'
`verifyWebhookDelivery`, works unchanged. The secret is created once and kept,
so you set it in your app's `.env` once:

```bash
echo "INBOUNDR_WEBHOOK_SECRET=$(inboundr listen --print-secret)" >> .env
```

- `--to support@yourdomain.com` forwards only email sent to that address.
- `--secret whsec_…` signs with your own secret instead, e.g. your real
  endpoint's.
- `--header "Authorization: Bearer …"` adds a header to every request.
- `--json` prints one JSON line per event, for scripts: `"type": "delivery"`
  for each email forwarded, `"type": "error"` when checking for or fetching
  email failed.
- `--header` can't replace the headers the CLI sets itself (`content-type`,
  `user-agent`, the `x-inboundr-*` ones).

`listen` checks for new email every 2 seconds (`--interval`) and forwards
what arrives after it starts. An email it couldn't fetch is tried again on the
next checks. Text from emails (subjects, senders, bodies) is printed with
terminal control characters removed; `--json` output is the API's data as-is. Your real endpoints keep receiving deliveries as
usual. A delivery your server answers with an error is shown, not retried; use
`inboundr emails retry <id>` to deliver an email to your real endpoints again.

Works with a read-only API key.

## Commands

| Command | |
| --- | --- |
| `listen` | Forward new inbound email to a local URL |
| `emails list` | List email: `--direction`, `--to`, `--thread`, `--status`, `--limit`, `--cursor` |
| `emails get <id>` | Show one email (`--html` for the HTML body) |
| `emails reply <id>` | Reply in its thread: `--text`/`--html`, `--all`, `--from` |
| `emails send` | `--from`, `--to`, `--cc`, `--reply-to`, `--subject`, `--text`/`--html` |
| `emails retry <id>` | Deliver an email to its endpoints again |
| `emails attachment <id> <index>` | Download an attachment (`-o` path, `-o -` for stdout) |
| `threads get <id>` | Every email in a thread |
| `domains list` | Your domains and their status |
| `addresses list` | Addresses and the endpoints they route to |
| `endpoints list` | Your endpoints |
| `endpoints test <id>` | Send a sample delivery and show what it answered |
| `endpoints deliveries <id>` | Recent deliveries and your server's answers (`--status failed`) |
| `shield-rules list` | Shield rules, in the order they run |
| `suppressions list` | Addresses sending won't deliver to |
| `login`, `logout`, `status` | Manage the saved API key |

Bodies can come from a file or stdin: `--text-file reply.txt`, or `--html -`
to read stdin.

Every command takes `--json` for the API's JSON, which pipes into `jq`:

```bash
inboundr emails list --direction inbound --json | jq -r '.data[].subject'
```

Run `inboundr <command> --help` for every flag.

## Environment

| Variable | |
| --- | --- |
| `INBOUNDR_API_KEY` | API key, over the saved one |
| `INBOUNDR_BASE_URL` | API origin, default `https://inboundr.net` |
| `INBOUNDR_CONFIG_DIR` | Where to keep `config.json` |
| `NO_COLOR` | No colour |

## License

MIT
