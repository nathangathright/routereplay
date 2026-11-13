// AI Elements' Conversation (https://elements.ai-sdk.dev, Apache-2.0), stock, without the transcript download (so
// without the `ai` package), plus ConversationFollow.
import { ArrowDownIcon } from 'lucide-react';
import { type ComponentProps, useCallback, useEffect, useRef } from 'react';
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom className={cn('relative flex-1 overflow-y-hidden', className)} initial="smooth" resize="smooth" role="log" {...props} />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  <StickToBottom.Content className={cn('flex flex-col gap-8 p-4', className)} {...props} />
);

/**
 * Not in AI Elements: scrolls to the newest message whenever `messages` changes (after the person sends one, say), so a
 * conversation that opens at its first line still follows along once it gets going.
 */
export const ConversationFollow = ({ messages }: { messages: number }) => {
  const { scrollToBottom } = useStickToBottomContext();
  const seen = useRef(messages);
  useEffect(() => {
    if (seen.current === messages) return;
    seen.current = messages;
    void scrollToBottom();
  }, [messages, scrollToBottom]);
  return null;
};

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({ className, ...props }: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    void scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        aria-label="Scroll to the newest message"
        className={cn('absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full dark:bg-background dark:hover:bg-muted', className)}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};
