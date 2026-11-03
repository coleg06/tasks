import { useEffect, useRef } from 'react';

export type Hotkey = {
  /** Single character, or 'mod+k' for ⌘/Ctrl combinations. */
  key: string;
  run: (event: KeyboardEvent) => void;
  /** Allow the binding to fire while a field has focus. Defaults to false. */
  whileTyping?: boolean;
};

function isTyping(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

export function useHotkeys(bindings: Hotkey[]) {
  const current = useRef(bindings);
  current.current = bindings;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const typing = isTyping(event.target);
      const combo = event.metaKey || event.ctrlKey ? `mod+${event.key.toLowerCase()}` : null;

      for (const binding of current.current) {
        const matches = combo ? binding.key === combo : binding.key === event.key;
        if (!matches) continue;
        if (typing && !binding.whileTyping) continue;
        event.preventDefault();
        binding.run(event);
        return;
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
