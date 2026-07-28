## Overview

### How the action makes a GitHub issue from a Vantik issue

This action makes a GitHub issue from a Vantik issue. A label starts it.

A person puts the label on a Vantik issue in a team that you configure. The
action then makes a GitHub issue in the repository that you configure. For
example, you put the label "GitHub" on a Vantik issue in the "Engineering" team.
The action makes an issue in the "xyz" repository.

The action needs three values:

1. The GitHub repository for the new issue.
2. The Vantik team for the action.
3. The label that starts the action.

### How to configure the action

#### 1. First, connect GitHub to Vantik

   - Open `Settings -> Overview -> Integrations -> GitHub`.
   - Give Vantik access to your GitHub account.

#### 2. Configure the action

   - Open `Settings -> Overview -> Actions -> GitHub -> Configuration`.
   - Give the name of the repository, the Vantik team, and the label.

### Important notes

- Each Vantik team can link to one GitHub repository only.
- One label starts the action for all the linked repositories and all the
  linked teams.
