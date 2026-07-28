## Overview

This action makes an issue in Vantik from an email message.

1. Create an issue from an email.

   - Gmail sends the message to the action on a webhook.
   - The action reads the message from the Gmail API.
   - It puts the new issue in triage, where a person accepts it or rejects it.

2. Select the team for the issue.

   - The action reads the `Delivered-To` header of the email.
   - It maps that address to a team. One address therefore serves one team.

3. Keep the content of the message.

   - The action changes the HTML body of the email into the rich-text format of
     a Vantik issue.
   - It uploads each attachment of the email to the issue.
   - It uses the subject line of the email as the title of the issue.

With this action a person who does not use Vantik can report a problem. That
person only sends an email.
