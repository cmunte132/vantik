## Overview

This action connects Vantik to Discord. It creates issues from Discord
messages, and it keeps a Discord thread and a Vantik comment thread in step.

1. Create an issue with an emoji reaction.

   - Put an emoji reaction on a Discord message.
   - The action then makes a triage issue in Vantik from that message.
   - With this feature a person who does not use Vantik can report a problem.

2. Keep the conversation threads in step.

   - The action links the issue to the Discord channel of the message.
   - Each later message in that channel becomes a comment on the linked issue.
   - The action ignores a message from the Vantik bot, so no loop occurs.

3. Set up the action.

   - Give Vantik access to your Discord server. Read the documentation for the
     Discord integration.
   - The action reads its inputs from the configuration of the action. See
     `handlers/get-inputs.ts` for the inputs that it needs.
