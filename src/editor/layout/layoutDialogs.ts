// Which layout dialogs are open (ADR 0174): Save Layout As… and Manage Layouts….
import { signal } from "@preact/signals";

export const saveLayoutAsOpen = signal(false);
export const manageLayoutsOpen = signal(false);
