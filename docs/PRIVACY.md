# Quietfort privacy policy

Last updated: 2026-11-21

## The short version

- Quietfort blocks ads, trackers, cookie pop-ups and dangerous sites **inside your browser**. What you browse is never sent to us.
- There are no accounts, no analytics, no advertising and no crash reporting. We don't sell or share personal data.
- The only things Quietfort downloads on its own are filter lists, straight from the people who maintain them.
- The optional AI features use a model that runs on your device. Page text is never sent to us or to an AI company.

## Who we are

Quietfort is an open-source browser extension for Chrome, Firefox and Safari (including Edge, Brave, Opera and other browsers built on Chrome). Its code is public at https://github.com/EnigmaticZee/Quietfort-extension, so anyone can check what this policy says.

## What happens on your device

To block ads and trackers, Quietfort has to look at the pages you open and the requests they make. All of it happens inside your browser:

- **Requests.** Each request a page makes is checked against filter lists. Blocked requests never leave your device.
- **Pages.** Quietfort hides ad slots, rejects cookie pop-ups and runs small fixes inside the page.
- **On-device AI (optional, off by default).** Some features ask the browser's own on-device model about a short, trimmed piece of a page, for example "is this block an ad?" or "which part of the page is the newsletter pop-up?". The model runs on your device. We never receive the text or the answers. Where the browser has no such model, Quietfort uses plain word matching instead.

## What leaves your device, and who gets it

| What | Sent to | When | What they can see |
|---|---|---|---|
| **Filter list downloads** | The list maintainers' own servers: easylist.to, secure.fanboy.co.nz, easylist-downloads.adblockplus.org, GitHub (github.io and githubusercontent.com: The Block List Project, 1Hosts, NoCoin, the uBlock Origin and AdGuard lists, regional lists), and any custom list address you add. | When a list is first turned on, then about once a day | Your IP address, the list being downloaded and your browser version. No browsing data. |
| **Downloading the AI model** | Your browser's maker (for Chrome, Google), done by the browser itself | Only if you choose to download it | Whatever the browser maker receives for a normal model download, under their own policy. |
| **Extension updates** | The browser's extension store | Handled by your browser | The same as for any other extension you install. |

Any server can see your IP address and basic technical details. That is how the internet works; we link to the maintainers above so you can read their policies.

**Privacy signals.** By default Quietfort adds the Global Privacy Control signal (`Sec-GPC: 1`) to your requests and trims the page address other sites receive. You can turn both off in Settings. Some browsers, such as Brave, keep these on regardless.

## What we don't do

- We don't collect your browsing history, the pages you visit or what is blocked.
- We don't use analytics, advertising code or crash-reporting services.
- We don't sell, rent or share personal data.
- We don't have user accounts or servers that receive your data.
- "Report a problem" saves your note **on your device only**.

## What is stored on your device

This data stays in your browser. We can't see it. Removing the extension deletes it.

| Data | How long |
|---|---|
| Settings, your own rules, trusted sites and elements you chose to hide | Until you change them or remove the extension |
| Downloaded filter lists | Replaced when updated |
| Blocked counts per tab and the "What was blocked" log | Until the tab or browser closes |
| AI answers, saved per site so the model isn't asked again (up to 500 sites) | Oldest removed first; "Forget AI decisions" clears them |
| "Report a problem" notes (page address and your note, last 50) | Until you remove the extension |

Backups you make with **Settings → Backup** are files you save yourself; they contain your settings and rules, nothing about your browsing.

## Children

Quietfort is not directed at children and collects no personal data from anyone, including children.

## Your rights

Laws such as the GDPR, UK GDPR, CCPA/CPRA and PIPEDA give you rights over your personal data. Because Quietfort collects none, there is normally nothing for us to access, correct or delete. If you contact us, we use what you send only to reply.

## Changes to this policy

If this policy changes, the date at the top changes too, and the history of this file on GitHub shows exactly what changed. If a change ever means more data leaves your device, Quietfort will tell you before it takes effect.

## Contact

Open an issue at https://github.com/EnigmaticZee/Quietfort-extension/issues. For security problems, use GitHub's private "Report a vulnerability" form on the repository's Security tab (see `SECURITY.md`).
