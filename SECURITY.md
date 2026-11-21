# Security policy

Quietfort runs inside your browser on every page you open, so security bugs here can hurt people. Thank you for helping keep it safe.

## Reporting a vulnerability

Please report privately and **don't open a public issue**. Use **"Report a vulnerability"** on this repository's Security tab (a private GitHub security advisory).

Please include:

- what is affected (browser and version, Quietfort version or commit);
- steps to reproduce, or a proof of concept;
- what an attacker could do with it;
- whether and how you'd like to be credited.

You'll get a reply within a week. Fixes for confirmed problems ship as soon as they're ready, and the advisory is published once users have the fix.

## In scope

- A web page reading or changing Quietfort's settings, rules or stored data, or talking to its background service worker.
- A page or filter list making Quietfort run code in a page or extension context it shouldn't.
- Bypasses of the dangerous-site warning page, or "Continue" being triggered without the user.
- Privacy leaks: anything that sends browsing data off the device (see `docs/PRIVACY.md`).
- Crashes or hangs triggered by web content or filter lists.

## Out of scope

- Ads or trackers that aren't blocked (please open a normal issue).
- Problems in third-party filter lists themselves (report them to the list's maintainers).
- Attacks that need someone who already controls your computer or browser profile.
