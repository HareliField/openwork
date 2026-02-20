import * as React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

type StatusMessageVariant = 'success' | 'error' | 'warning' | 'loading';

interface StatusMessageProps extends React.ComponentProps<'div'> {
  variant: StatusMessageVariant;
}

const statusConfig: Record<
  StatusMessageVariant,
  {
    containerClass: string;
    iconClass: string;
    Icon: React.ComponentType<{ className?: string }>;
    role: 'alert' | 'status';
    ariaLive: 'assertive' | 'polite';
  }
> = {
  success: {
    containerClass: 'border-success/40 bg-success/10 text-success',
    iconClass: '',
    Icon: CheckCircle2,
    role: 'status',
    ariaLive: 'polite',
  },
  error: {
    containerClass: 'border-destructive/40 bg-destructive/10 text-destructive',
    iconClass: '',
    Icon: AlertCircle,
    role: 'alert',
    ariaLive: 'assertive',
  },
  warning: {
    containerClass: 'border-warning/40 bg-warning/10 text-warning',
    iconClass: '',
    Icon: AlertTriangle,
    role: 'alert',
    ariaLive: 'assertive',
  },
  loading: {
    containerClass: 'border-muted-foreground/30 bg-muted/50 text-muted-foreground',
    iconClass: 'animate-spin',
    Icon: Loader2,
    role: 'status',
    ariaLive: 'polite',
  },
};

function StatusMessage({ variant, className, children, ...props }: StatusMessageProps) {
  const { containerClass, iconClass, Icon, role, ariaLive } = statusConfig[variant];

  return (
    <div
      data-slot="status-message"
      role={role}
      aria-live={ariaLive}
      className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', containerClass, className)}
      {...props}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconClass)} />
      <span>{children}</span>
    </div>
  );
}

export { StatusMessage };
