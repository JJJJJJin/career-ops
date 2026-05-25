# flow: seek search smoke test

Read-only smoke test for the agent engine. It exercises the full loop —
perceive, resolve (or cache hit), act — against SEEK's public search page.

Hard rules for this flow: do NOT log in, do NOT apply to anything, do NOT
submit any application. Only type a search query and run it. This flow exists
to prove the engine works end to end before any real automation is wired.

## accept the cookie banner if present

If a cookie or privacy consent banner is visible, click the button that
accepts all cookies (its label is usually "Accept all cookies" or "Accept").
If there is no such banner on the page, skip this step.

## type the search keyword

Type the phrase "graduate software engineer" into the main keywords search
box (the "What" field where you enter a job title or keyword).

## run the search

Submit the search by pressing the Enter key. The keywords box still has focus
from the previous step, so pressing Enter runs the search for the entered
keyword. (We press Enter rather than clicking the search button because SEEK's
autocomplete suggestions dropdown overlays the button and intercepts clicks.)

## confirm results are showing

The search results list is now visible. There is nothing left to do — this
flow's goal is reached, so this step is done.
