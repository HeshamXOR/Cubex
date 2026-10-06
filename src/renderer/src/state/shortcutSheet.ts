import { create } from 'zustand'

/** Whether the keyboard shortcut sheet is open. The palette and the shortcut itself both open it. */
export const useShortcutSheet = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))
