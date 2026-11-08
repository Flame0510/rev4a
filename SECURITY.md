# Security Policy

Rev4a holds sensitive things: provider API keys, the dashboard password, agent
sign-ins and a terminal into every agent container. If you find a way to reach any
of them without authorization, please tell us privately first, so installs can be
fixed before the problem is public.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**
   (direct link: <https://github.com/Flame0510/rev4a/security/advisories/new>).
3. Describe the problem, the Rev4a version (`rev4a --version` or the version shown in
   the dashboard) and the steps to reproduce it. A proof of concept helps, but is not
   required.

The report stays private: only you, the repository administrators and anyone invited
to the advisory can see it. There is no security email address: GitHub's private
reporting is the only channel.

Please do not test against installs you do not own, and do not access, change or
delete other people's data while investigating.

## Supported versions

Rev4a has a single maintainer, so fixes go only into the **latest release** on npm.
Older versions do not receive patches: update from the dashboard banner or with
`rev4a update` to get a fix.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Any older release | No |

## What happens after you report

- The aim is a first answer within **7 days**. Rev4a has a single maintainer, so it can
  take longer at times.
- The report is investigated. If the problem is confirmed, the fix goes into a new
  release as soon as it is ready, and you are kept informed in the private advisory
  while it is prepared.
- Once the fixed release is out, the advisory is published, with credit to you if you
  want it.

## Scope

In scope: the Rev4a code in this repository and the npm package built from it. This
includes the dashboard and its login, the API routes, the provider proxy and key
vault, the container terminal, the session daemon, the agent base image built from
`agent-templates/base-image/`, and the self-update flow.

Out of scope (a problem in a dependency is better reported to its own project):

- vulnerabilities in OpenClaw itself, Docker, Node.js or other dependencies, unless
  Rev4a uses them in an unsafe way;
- problems that need an attacker who already has the dashboard password, root on the
  host or access to the Docker socket;
- problems caused only by how an operator deployed Rev4a, such as exposing it to the
  internet over plain HTTP or choosing a weak password.
