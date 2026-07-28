# Security policy

**Last update:** 2025-03-09

## How to report a vulnerability

A responsible disclosure of a vulnerability keeps the project safe. If you find
a security problem, do these steps:

1. **Do not open a public issue.**
   - A public report before a fix puts the users in danger. Report the problem
     privately.

2. **Write to the Vantik security team.**
   - Send an email to **`harshith at vantik.dev`**. Use the subject line
     **"Security Vulnerability Report"**.
   - Give a full description. Include this data:
     - The steps that make the problem occur again
     - The components with the problem
     - Your evidence: logs, a proof of concept, or screenshots

3. **Wait for the answer.**
   - The team sends you an acknowledgement in **one business day**.
   - The security team can ask you for more detail.

4. **Keep the report confidential.**
   - Do not make the vulnerability public before the team corrects it.
   - Vantik tells you when a fix is available. The team then agrees a schedule
     for the disclosure with you.

## Vulnerabilities that are out of scope

This policy does not treat these types as a security problem:

- Clickjacking on a page with no sensitive action.
- **CSRF** on login, on logout, or with no authentication.
- An attack that needs a **man in the middle (MITM)**, or physical access to a
  device.
- A **denial of service (DoS) attack**, or any other action that stops the
  service.
- Content spoofing or text injection **with no clear attack vector**.
- **Email spoofing**, if you cannot exploit it directly.
- An absent **DNSSEC, CAA, or CSP header**.
- An absent **Secure** or **HttpOnly** flag on a cookie that is not sensitive.
- A **dead link**.

If you do not know if this policy includes your issue, you can still write to
the team for an answer.

## Rules for a test

When you test for a vulnerability, obey these rules:

- **Do not run an automated scanner** before you get approval. A scanner puts an
  unnecessary load on the server.
- **Do not read, change, or delete** user data or sensitive information.
- **Do not do an aggressive test** that stops the system.

For a deep security test, write to the Vantik security team first. Agree the
scope with the team, and get its permission.

## What to expect

- The team sends you an **acknowledgement** in **one business day**.
- The security team can ask you for more information.
- The team corrects the problem as fast as it can, and it keeps you informed.
- After the team makes the **fix**, it tells you about the patch.
- The team takes **no legal action** against a researcher who reports a
  vulnerability responsibly.
- The team gives you permission to make the issue **public** after the users get
  enough time to update.
