// AI Elements' PromptInput (https://elements.ai-sdk.dev, Apache-2.0), stock, trimmed to the parts this chat uses: the
// form around shadcn's InputGroup, the textarea that sends on Enter, the footer and the submit button. No attachments,
// menus or model pickers.
import { CornerDownLeftIcon } from 'lucide-react';
import type { ComponentProps, FormEvent, KeyboardEventHandler } from 'react';
import { useCallback, useState } from 'react';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

export type PromptInputProps = Omit<ComponentProps<'form'>, 'onSubmit'> & {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
};

export const PromptInput = ({ className, children, onSubmit, ...props }: PromptInputProps) => (
  <form
    className={cn('w-full', className)}
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit(e);
    }}
    {...props}
  >
    <InputGroup className="overflow-hidden">{children}</InputGroup>
  </form>
);

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

export const PromptInputTextarea = ({ onKeyDown, className, placeholder = 'What would you like to know?', ...props }: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      onKeyDown?.(e);
      if (e.defaultPrevented) return;
      if (e.key === 'Enter') {
        if (isComposing || e.nativeEvent.isComposing) return;
        if (e.shiftKey) return;
        e.preventDefault();
        // Check if the submit button is disabled before submitting
        const { form } = e.currentTarget;
        const submitButton = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
        if (submitButton?.disabled) return;
        form?.requestSubmit();
      }
    },
    [onKeyDown, isComposing],
  );

  return (
    <InputGroupTextarea
      className={cn('field-sizing-content max-h-48 min-h-16', className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, 'align'>;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon align="block-end" className={cn('justify-between gap-1', className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton>;

export const PromptInputSubmit = ({ className, variant = 'default', size = 'icon-sm', children, ...props }: PromptInputSubmitProps) => (
  <InputGroupButton aria-label="Submit" className={cn(className)} size={size} type="submit" variant={variant} {...props}>
    {children ?? <CornerDownLeftIcon className="size-4" />}
  </InputGroupButton>
);
