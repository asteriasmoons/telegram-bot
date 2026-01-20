// src/commands/_event.callbacks.ts
export const CB = {
  // Add flow
  ADD_ALLDAY_YES: "ev:add:allday:yes",
  ADD_ALLDAY_NO: "ev:add:allday:no",
  ADD_SKIP_DESC: "ev:add:skip:desc",
  ADD_SKIP_LOC: "ev:add:skip:loc",
  ADD_SKIP_COLOR: "ev:add:skip:color",
  ADD_CONFIRM_CREATE: "ev:add:confirm:create",
  ADD_CONFIRM_CANCEL: "ev:add:confirm:cancel",

  // List picking (used by edit/delete flows)
  PICK_EVENT_PREFIX: "ev:pick:", // + <eventId>

  // Edit flow field pick
  EDIT_FIELD_PREFIX: "ev:edit:field:", // + fieldName
  EDIT_CONFIRM_SAVE: "ev:edit:confirm:save",
  EDIT_CONFIRM_CANCEL: "ev:edit:confirm:cancel",

  // Delete flow
  DEL_CONFIRM_YES: "ev:del:confirm:yes",
  DEL_CONFIRM_NO: "ev:del:confirm:no",
} as const;