// src/state/conversationStore.ts
import { Types } from "mongoose";

export type FlowKind = "event_add" | "event_edit" | "event_delete";

export type EventAddDraft = {
  title?: string;
  date?: string;      // YYYY-MM-DD
  time?: string;      // HH:MM
  allDay?: boolean;
  description?: string;
  location?: string;
  color?: string;
};

export type EventEditDraft = {
  eventId: string;
  field?: "title" | "date" | "time" | "allDay" | "description" | "location" | "color";
  value?: string | boolean;
};

export type ConversationState =
  | { kind: "event_add"; step: "title" | "date" | "time" | "allDay" | "description" | "location" | "color" | "confirm"; draft: EventAddDraft }
  | { kind: "event_edit"; step: "pick_event" | "pick_field" | "enter_value" | "confirm"; draft: EventEditDraft }
  | { kind: "event_delete"; step: "pick_event" | "confirm"; draft: { eventId?: string } };

const store = new Map<number, ConversationState>();

export function getState(userId: number) {
  return store.get(userId);
}

export function setState(userId: number, state: ConversationState) {
  store.set(userId, state);
}

export function clearState(userId: number) {
  store.delete(userId);
}