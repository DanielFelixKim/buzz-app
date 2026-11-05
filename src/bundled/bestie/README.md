# Bestie

Bestie is the account-saved agent pinned in Buzz's left navigation. The
selection is the private `main-agent` record shared with Solo's default-agent
owner; this plugin adds presentation and a conversation destination, not another
selection store.

## Getting started

### Pinned conversation

When the account has a saved eligible Bestie, the sidebar row adopts that
agent's name and avatar and opens their canonical direct message. The canonical
conversation is the newest verified, unarchived, non-cached DM whose roster
contains the viewer and exactly that one other public key. A Solo chat, group DM,
namesake, unknown roster or archived/cached channel never qualifies. If no exact
DM exists, the page asks the shared direct-message service to open one after
rechecking that the agent remains selectable. If agent discovery fails, an
already-verified exact DM stays usable; opening a missing one still requires a
selectable agent. Known-archived agents and agents confirmed absent from a complete
inventory do not keep a pinned conversation.

The page uses the ordinary conversation owners for history, drafts, sending,
threads and unread state. Thread visits bind to their originating DM. Restoring
one after the Bestie or canonical DM changes retires incompatible thread visits
and shows the current Bestie's chat; it never reads an old thread in the new DM.
While that exact DM is promoted, Messages omits its
ordinary row and clears any old device-local hidden-DM intent. Replacing or
deleting the Bestie, disabling the plugin, changing communities, or losing the
exact roster match releases the promotion and restores the ordinary DM row.

The pinned row and Search Buzz destination show the agent's name and avatar.
Search adds **Bestie** as supporting text and matches either name, so the pinned
DM remains recognizable without presenting a placeholder identity. Agent rows
remain separate **New chat** actions; namesakes stay distinct by exact public key
and use readable owner labels before abbreviated-key fallbacks.

### The Bestie tab

The agent you made your Bestie (with **Make my bestie** in Agents) gets a
**Bestie** tab on its agent page. **Change** picks
another agent and asks before replacing your Bestie. A remote agent, hosted or
on another device, can be your Bestie too. Change, **Make my bestie** and **Make
my Bestie again** offer it, and say before saving that some bestie features
aren't available with remote agents, as **Choosing a Bestie** does: one
question, the replacement's, when it replaces your Bestie. A remote Bestie's
switches show as unavailable, as its instructions and timers aren't on this
device, and it doesn't start with Remembers you on. **Remove as Bestie** asks,
then saves no Bestie to your account: the agent stays, its check-ins stop, and
its memory section and private channels stay, which its Former Bestie tab can
turn off.

**Remembers you** adds memory rules to the agent's instructions, in a section
marked `<!-- buzz:bestie/memory v1 -->` … `<!-- /buzz:bestie/memory -->`, and
turning it off removes that section. The switch is on while the section is
there, whatever you edit inside it or type next to its markers. Off removes
it with your edits inside it, and keeps text you put before its opening
marker or after its closing one. If you edit, remove or copy one of its
markers, the row says the section was edited instead of showing a switch, so
it never adds a second one. **Restore** puts back the original section in
place of its two markers and what lies between them, when they still show
where it starts and ends; otherwise fix its markers in Instructions. Off
deletes no memory, and the agent's core memory is still in every prompt;
clear memory in the Memory tab.

**Private channels Bestie can read** lists the private channels you share with
Bestie, each with **Remove**, which asks first, as the Members dialog does.
**Add to a channel** (**Choose…**) and **Add to
all my private channels** add it to the private channels you are in, most
recently active first; each channel's members see that you added it. Bestie
joins as a guest, so it reads the channel but can't post there. Each
action has a row of its own, so in a narrow panel its button wraps under it.
Until your channel list has loaded in full, the section says so instead of
saying Bestie is in none: a failed read offers **Retry**, the channels already
known keep their rows, and **Add to all** waits for the full list. A channel
known only from a cached list offers no change until it is read again.
When a row or the Add rows leave with focus in them, focus moves to the
control now in their place, or to the section heading if none is left, unless
you already moved it elsewhere.
Changing your Bestie stops an **Add to all** still under way.
Public channels
need nothing: agents read them already. Adding Bestie to new channels you
create is not set up yet.

**Check-ins → Every hour** needs Remembers you, and turning memory off turns it
off too. On adds the `buzz:bestie/checkin.hourly` Hourly upkeep section to the
instructions and an hourly Attention timer, `watch/bestie-hourly-check-in`,
that wakes Bestie in your DM with it. Each check-in reads what is new in
that DM and in the private channels Bestie was added to, and reports only in
the DM. On also turns on the agent's Attention,
which the Watching tab shows. Off removes the section and the timer and leaves
Attention on, since the agent's other watches may need it. The timer runs while
Buzz is open and the Watching plugin is on: this plugin doesn't call
`controlAttention()`, so turning Watching off still turns Attention off for
every agent. While the timer can't run, the row says it is paused, and a
timer paused on its own in the Attention tab says to turn the switch off and on
again to restart it. If the instructions fail to save after the timer did, On
removes the timer again, and turns Attention back off if it turned it on; a
timer still left without its section gets a **Remove** row. After a
sleep it runs once, not once for each missed hour. Each
check-in is a feature in `features.ts`, so another kind is one more entry.

**Changing your Bestie.** Only your Bestie checks in: whenever the saved Bestie
is known, chosen here or read from your account, any other agent here has its
check-ins removed. Once your account is read to have saved no Bestie, as
**Remove as Bestie** does, every agent here has them removed. An account where
no Bestie was ever chosen changes nothing, as an agent here may be Bestie in
another community that shares its instructions. While the account is being read,
or can't be, nothing is removed either. A choice made on another device reaches
this one when it next reads your account, once per connection. Turning the
Bestie plugin off stops a removal under way before its next save. Its memory
section and channels stay. An agent this device makes Bestie starts with
Remembers you on; a choice synced from elsewhere changes nothing, so memory
turned off stays off. A former Bestie keeps a **Former Bestie** tab while it has
a Bestie section, or, if this device saw it as Bestie, while it is in one of
your private channels. The tab has the same switches, **Remove from all** for
its channels, and **Make my Bestie again**.

### Choosing a Bestie

The account choice is read before the page decides what to show. Reconnecting
and incomplete or failed inventory reads remain on the pinned destination with
their own recovery. Once a complete read proves that the saved agent is gone,
the same chooser appears in place instead of sending the owner to another menu.

A successful account read with no saved Bestie shows **Choose your bestie agent**,
where the owner can search eligible existing agents in a picker with avatars,
names and short public-key labels, or open the shared **Create agent** dialog.
Known hosted agents and agents on another device remain eligible, but require
confirmation before saving: **Some bestie features aren’t available with remote
agents.** This also applies after creating one through Builderlab.
Cancel leaves the account choice unchanged and keeps any newly created agent.
Local choices save directly. Both paths save through `main-agent`, then hand off
to the canonical DM; this does not configure memory or check-ins for remote agents.
A finished agent deletion saves `agent: null` only when a fresh account read still
names that agent. Another choice already visible to that read is left alone.
This is a read/replace, not an atomic compare-and-swap: a choice made on another
device between the read and publish can still be overwritten. A cleanup failure
reports that the agent was deleted but its Bestie choice could not be cleared;
open Bestie to choose another.

Builderlab no longer owns a separate Bestie setup, agent, Solo chat, or
selection path.

---

## Navigation prototypes (development only)

The header's **Bestie prototype** switch compares **Current panel**, **Top nav**
(the development default), and **Floating avatar**. It is a presentation choice
saved only for this app session, not an account or agent preference. Release
builds retain Current panel. Top nav places the saved Bestie's avatar beside
Search in the same round 40px control and hover treatment as Search, with a
smaller 24px circular portrait. Floating avatar places a prominent 80px circular
portrait at the bottom right, bottom-aligned with the ordinary composer and
inset 32px from the right edge, with a subtle outline and soft shadow. Circular
agent portraits here are user-requested prototype exceptions, not a change to
identity shapes elsewhere.
Both remove the special sidebar pin and leave the canonical DM in the ordinary
Direct messages list.

In the two new variants, **Ask Bestie…** in a message's actions opens an anchored
form with the author, source excerpt and link association. **Catch me up** and
**Find the next step** fill editable questions; only **Send** submits. Sending
closes the form and stays in the source conversation. The toast acknowledges
queueing, not relay delivery or agent completion. No “Watch this” action is
implemented: this prototype creates asks, not monitoring subscriptions.

The avatar opens one shared Bestie home: **Chat with [Bestie]** opens the canonical
DM through ordinary navigation; **Recent asks** lists at most 20 explicit asks
from this app session, newest first. A small indicator reflects existing unread
evidence, including the DM. Recent rows distinguish Starting, Queued, Sent,
Check delivery and an actual reply. These are delivery/read states, not proof
that an agent is running. Pending or failed creation remains inspectable and can
be retried; only a definitively uncreated chat gets a fresh creation attempt.
Message delivery recovery remains with the outbox, never a duplicate submission.

Selecting an ask opens a bounded, expanded Popover with the ordinary timeline and
follow-up composer. **Back** returns to the home, **View source** returns to the
original message/thread, and **Open conversation** hands off to normal navigation.
There are no local tabs or additional history visits. Escape/outside dismissal
closes the popover; ordinary scoped drafts survive reopening. Accepted requests
and live reply demand outlive the source row, popover and placement switch.

The recent index is deliberately in memory: reload, a known account/community
change or disabling Bestie clears it; the created Solo chats remain. Unknown
account scope withholds source previews. Same-account reconnect retains the
index internally but old async callbacks cannot publish through a new session.
No polling, watch lifecycle, durable ask reconstruction or native/protocol change
is added. Existing conversation, selection, archive, membership and signing
owners retain their checks.

The signed ephemeral fixture now mounts the real AppShell and sidebar.
`tests/browser/bestie-catch-up.spec.mjs` checks both placements, canonical-DM
handoff and ordinary inventory, a live reply while closed, focus/draft handoffs
and viewport bounds in Chromium/WebKit. Mounted tests in
`CatchUpWorkspace.test.tsx` own explicit submission, no duplicates, scope fences
and refused-create recovery. These do not establish real native agent acceptance.

## Contextual catch-up (test iteration)

**Catch me up** in a message menu opens one Bestie exchange in the shell's
right-hand split. For a thread, Channels moves its retained thread tab into the
main pane, keeping its reply draft. The source reference stays fixed when the
viewer browses another channel. **View thread/post** returns to that source.
The excerpt wraps to two lines within a shrinkable panel; it is not a long
single-line action. The panel header and return control use the agent's actual
avatar through the existing shared artwork and protected-media paths.

The panel and follow-up composer stay mounted while hidden. Hide/Escape only
changes presentation; the top-bar Bestie catch-up button reopens the same exchange
and uses the existing unread evidence to indicate a reply. Selecting the same
source again reopens it without resubmitting. A different source replaces the
one in-memory exchange; previous conversations remain ordinary Solo chats.

Requests use the existing private Solo creation, membership and outbox path.
They are submitted once per opening, after the create is confirmed. Hiding or
changing channels never cancels an accepted request. Navigating to another
community/account or disabling Bestie drops the presentation and prevents a
not-yet-submitted request from sending. Reload does not reconstruct the panel.
Source/channel access and all publication checks remain with the relay session.

The companion is deliberately not an addressable content tab: opening/hiding it
adds no navigation visit. Its source thread keeps the existing Back/Forward and
explicit-close contract. Another shell companion takes presentation while the
catch-up remains reopenable. Narrow windows use the shared pane overlay, not an
additional modal or third column.

This iteration supports message/post and thread entry points in non-Solo
conversations. Channel-wide catch-up, Solo-thread placement, multiple active
exchanges and reload recovery are not implemented. Fixture-based browser checks
use `tests/fixtures/bestie-catch-up.html`; mounted lifecycle coverage lives in
`CatchUpWorkspace.test.tsx`. `tests/browser/bestie-catch-up.spec.mjs` covers long
source geometry and a signed reply delivered through the transport's live callback
without a finite refresh, in both browser engines. Neither establishes native
live-agent response quality.
