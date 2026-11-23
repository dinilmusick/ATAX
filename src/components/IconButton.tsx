import React from 'react';

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  tooltipSide?: 'top' | 'bottom' | 'left' | 'right';
  variant?: 'default' | 'accent' | 'ivory';
  children: React.ReactNode;
}

export function IconButton({
  label,
  active = false,
  tooltipSide = 'bottom',
  variant = 'default',
  className = '',
  children,
  ...props
}: IconButtonProps) {
  const tooltipPos =
    tooltipSide === 'top'
      ? 'bottom-full left-1/2 -translate-x-1/2 mb-2'
      : tooltipSide === 'left'
      ? 'right-full top-1/2 -translate-y-1/2 mr-2'
      : tooltipSide === 'right'
      ? 'left-full top-1/2 -translate-y-1/2 ml-2'
      : 'top-full left-1/2 -translate-x-1/2 mt-2';

  const variantClasses =
    variant === 'accent'
      ? active
        ? 'bg-[#C83214] text-[#F7F3EC] border-[#E04819]'
        : 'bg-[#261B17] text-[#E6DDD1] border-[#4A362D] hover:border-[#C83214] hover:text-[#F7F3EC]'
      : variant === 'ivory'
      ? active
        ? 'bg-[#DFE4D8] text-[#18120F] border-[#DFE4D8]'
        : 'bg-[#231814] text-[#D8CFC2] border-[#433129] hover:bg-[#2F211B] hover:text-[#F2EBE1]'
      : active
      ? 'bg-[#C83214] text-[#F7F3EC] border-[#E04819]'
      : 'bg-[#1F1512] text-[#CBBFB2] border-[#3F2E27] hover:bg-[#2B1D19] hover:text-[#F2EBE1] hover:border-[#6A4E42]';

  return (
    <div className="relative inline-flex items-center justify-center">
      <button
        type="button"
        aria-label={label}
        aria-pressed={active || undefined}
        className={`peer relative inline-flex items-center justify-center w-10 h-10 border rounded-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E04819] cursor-pointer ${variantClasses} ${className}`}
        {...props}
      >
        {children}
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${tooltipPos} z-50 whitespace-nowrap bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] px-2.5 py-1 text-[11px] font-medium tracking-wide rounded-xs opacity-0 peer-hover:opacity-100 peer-focus-visible:opacity-100 transition-opacity duration-150`}
      >
        {label}
      </span>
    </div>
  );
}
