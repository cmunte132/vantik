## Overview

This action connects Vantik to WhatsApp. It creates issues from WhatsApp
messages, and it keeps a WhatsApp chat and a Vantik issue in step.

1. Create an issue from a WhatsApp message.

   - WhatsApp sends the message to the action on a webhook.
   - The action makes a triage issue in Vantik for the team that you configure.
   - The action ignores a status message from WhatsApp.

2. Keep the comments in step.

   - The action links the issue to the WhatsApp chat of the first message.
   - Each later message in that chat becomes a comment on the linked issue.
   - Each new comment on the issue goes back to the WhatsApp chat.

3. Report a change of the issue.

   - When a person changes the issue, the action sends the change to the
     WhatsApp chat.
   - The person who made the report therefore sees the progress of the work.

With this action a person who does not use Vantik can report a problem. That
person only sends a WhatsApp message.
