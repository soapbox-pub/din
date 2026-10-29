import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { useDeleteSession, useRenameSession } from '@/hooks/useAssistant';
import { cleanAssistantError, sessionTitle, type SessionInfo } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { useAssistantHost } from '@/shared/assistant/host';

/**
 * A conversation's title, editable in place: Enter or leaving the field
 * saves it, Escape gives up. Shared by the tabs and the list, which both
 * offer Rename in their right-click menus.
 */
export function ConversationTitleInput({
  session,
  onDone,
  className,
}: {
  session: SessionInfo;
  onDone: () => void;
  className?: string;
}) {
  const rename = useRenameSession();
  const { notify } = useAssistantHost();
  const [title, setTitle] = useState(() => sessionTitle(session));

  const save = () => {
    onDone();
    const next = title.trim();
    if (!next || next === session.title) return;
    rename.mutate(
      { sessionID: session.id, title: next },
      { onError: (error) => notify({ title: 'Couldn’t rename', description: cleanAssistantError(error), destructive: true }) },
    );
  };

  return (
    <Input
      autoFocus
      value={title}
      onChange={(e) => setTitle(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') onDone();
      }}
      aria-label="Conversation title"
      className={cn('h-7 text-sm', className)}
    />
  );
}

/** Asks before deleting a conversation, then deletes it. */
export function DeleteConversationDialog({
  session,
  open,
  onOpenChange,
  onDeleted,
}: {
  session: SessionInfo | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteSession();
  const { notify } = useAssistantHost();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            It’s removed from OpenCode too, for every app that shows it. Files the assistant changed stay as they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={() =>
              session &&
              remove.mutate(session.id, {
                onSuccess: onDeleted,
                onError: (error) =>
                  notify({ title: 'Couldn’t delete', description: cleanAssistantError(error), destructive: true }),
              })
            }
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
