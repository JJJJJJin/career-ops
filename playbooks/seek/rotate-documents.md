# Playbook: SEEK resume rotation

Keep a tailored resume PDF available in SEEK's saved-resume list, which is capped at 10. When
full, the oldest non-default (and non-protected) resume is deleted to free a slot. This is
deterministic and destructive, so it runs through the tested `seek_resume_*` tools, not raw
clicks. Requires being logged in.

Vars: `{{pdfPath}}` (absolute path to the tailored resume PDF).

## review the current list
**Goal:** know what's saved and whether the target is already there.
**Do:** `seek_resume_list`. Note the count (limit 10), which is Default, and whether the
target filename is already present.
**Verify:** you have the list with `isDefault` flags.

## rotate-upload the tailored resume
**Goal:** ensure `{{pdfPath}}` is saved, freeing a slot if needed.
**Do:** `seek_resume_rotate { pdfPath }`. It is idempotent (skips if already uploaded);
otherwise, when the list is full, it deletes the OLDEST non-default/non-protected resume,
then uploads, then re-pins the protected default if one is configured.
**Verify:** the result reports the saved filename; `seek_resume_list` shows it.
**If unexpected:** "every resume is Default or protected" → STOP and ask the user to free a
slot manually (you must not delete a protected or default resume).
