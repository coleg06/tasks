import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useCreateTask } from '../api/queries';
import { parseComposerInput } from './composer-input';

export function Composer({
  assignees,
  onClose,
  onCreated,
  projectKey,
}: {
  assignees: { email: string; name: string }[];
  onClose: () => void;
  onCreated: (key: string) => void;
  projectKey: string;
}) {
  const [value, setValue] = useState('');
  const [mutationKey, setMutationKey] = useState(() => crypto.randomUUID());
  const input = useRef<HTMLInputElement>(null);
  const createTask = useCreateTask();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const parsed = parseComposerInput(value, assignees);

  function submit() {
    if (!parsed.title) return;
    createTask.mutate(
      {
        title: parsed.title,
        mutationKey,
        projectKey,
        priority: parsed.priority,
        dueDate: parsed.dueDate,
        assigneeEmail: parsed.assigneeEmail,
      },
      {
        onSuccess: (task) => {
          setValue('');
          setMutationKey(crypto.randomUUID());
          onCreated(task.key);
        },
      },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  const chips = [
    parsed.priority ? `!${parsed.priority}` : null,
    parsed.dueDate,
    parsed.assigneeEmail,
  ].filter(Boolean) as string[];

  return (
    <div className="task-composer">
      <input
        aria-label="New task title"
        onBlur={() => !value && onClose()}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Task name — try !high, >friday, @name"
        ref={input}
        value={value}
      />
      {chips.length ? (
        <span className="task-composer-chips">
          {chips.map((chip) => (
            <span className="chip" key={chip}>
              {chip}
            </span>
          ))}
        </span>
      ) : null}
    </div>
  );
}
