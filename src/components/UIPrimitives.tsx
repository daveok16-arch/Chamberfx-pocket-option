import React, { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { AlertCircle, Check, ChevronDown, ChevronUp, X } from "lucide-react";

// --- PANEL ---
interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: "default" | "elevated" | "glass";
  glow?: "none" | "bullish" | "bearish" | "info";
}
export const Panel: React.FC<PanelProps> = ({
  children,
  variant = "default",
  glow = "none",
  className = "",
  ...props
}) => {
  const bgClass =
    variant === "glass"
      ? "bg-panel/50 backdrop-blur-lg"
      : variant === "elevated"
      ? "bg-panel-elevated"
      : "bg-panel";

  const glowClass =
    glow === "bullish"
      ? "border-bullish/40 shadow-[0_0_30px_rgba(0,230,118,0.1)]"
      : glow === "bearish"
      ? "border-bearish/40 shadow-[0_0_30px_rgba(255,51,102,0.1)]"
      : glow === "info"
      ? "border-info/40 shadow-[0_0_30px_rgba(0,176,255,0.1)]"
      : "border-border-token";

  return (
    <div
      className={`border rounded-2xl p-6 md:p-8 shadow-xl transition-all duration-300 ${bgClass} ${glowClass} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};

// --- CARD ---
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  hoverable?: boolean;
}
export const Card: React.FC<CardProps> = ({
  children,
  hoverable = true,
  className = "",
  ...props
}) => {
  return (
    <div
      className={`bg-panel border border-border-subtle rounded-2xl p-6 transition-fintech ${
        hoverable ? "hover:border-border-token hover:bg-panel-hover" : ""
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};

// --- METRIC TILE ---
interface MetricTileProps {
  label: string;
  value: string | number;
  subtext?: string;
  trend?: "up" | "down" | "neutral";
  icon?: React.ReactNode;
  className?: string;
}
export const MetricTile: React.FC<MetricTileProps> = ({
  label,
  value,
  subtext,
  trend,
  icon,
  className = "",
}) => {
  const trendColor =
    trend === "up"
      ? "text-bullish"
      : trend === "down"
      ? "text-bearish"
      : "text-text-secondary";

  return (
    <div className={`bg-panel border border-border-subtle p-6 rounded-2xl flex items-center justify-between hover:border-border-token transition-fintech ${className}`}>
      <div className="space-y-2 min-w-0">
        <span className="text-sm text-text-secondary font-medium tracking-wide block">
          {label}
        </span>
        <span className="text-2xl md:text-3xl font-bold text-white font-mono block tracking-tight truncate">
          {value}
        </span>
        {subtext && (
          <span className={`text-xs block font-medium ${trendColor}`}>
            {subtext}
          </span>
        )}
      </div>
      {icon && (
        <div className="w-12 h-12 rounded-xl bg-panel-elevated border border-border-token flex items-center justify-center flex-shrink-0">
          {icon}
        </div>
      )}
    </div>
  );
};

// --- STATUS BADGE ---
interface StatusBadgeProps {
  status: "active" | "warning" | "error" | "neutral" | "success" | "info";
  label: string;
  pulse?: boolean;
}
export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  label,
  pulse = false,
}) => {
  const colorMap = {
    active: "bg-bullish/10 border-bullish/30 text-bullish",
    success: "bg-bullish/10 border-bullish/30 text-bullish",
    warning: "bg-warning/10 border-warning/30 text-warning",
    error: "bg-bearish/10 border-bearish/30 text-bearish",
    neutral: "bg-panel-elevated border-border-token text-text-secondary",
    info: "bg-info/10 border-info/30 text-info",
  };

  const dotColorMap = {
    active: "bg-bullish",
    success: "bg-bullish",
    warning: "bg-warning",
    error: "bg-bearish",
    neutral: "bg-text-secondary",
    info: "bg-info",
  };

  return (
    <div className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl border text-xs font-semibold tracking-wide ${colorMap[status]}`}>
      <span className={`w-2.5 h-2.5 rounded-full ${dotColorMap[status]} ${pulse ? "animate-pulse" : ""}`} />
      <span>{label}</span>
    </div>
  );
};

// --- SECTION HEADER ---
interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  badge?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}
export const SectionHeader: React.FC<SectionHeaderProps> = ({
  title,
  subtitle,
  badge,
  icon,
  action,
  className = "",
}) => {
  return (
    <div className={`flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-border-subtle gap-3 ${className}`}>
      <div className="flex items-start gap-3">
        {icon && <div className="text-info mt-1">{icon}</div>}
        <div>
          <h2 className="text-lg md:text-xl font-bold text-white tracking-tight flex items-center gap-2">
            {title}
            {badge && (
              <span className="text-xs bg-panel-elevated border border-border-token text-text-secondary px-2 py-0.5 rounded-lg font-medium">
                {badge}
              </span>
            )}
          </h2>
          {subtitle && (
            <p className="text-sm text-text-secondary font-sans mt-1">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action && <div>{action}</div>}
    </div>
  );
};

// --- SIGNAL BADGE ---
interface SignalBadgeProps {
  direction: "BUY" | "SELL" | "WAIT" | "CALL" | "PUT";
  className?: string;
}
export const SignalBadge: React.FC<SignalBadgeProps> = ({ direction, className = "" }) => {
  const isBuy = direction === "BUY" || direction === "CALL";
  const isSell = direction === "SELL" || direction === "PUT";

  if (isBuy) {
    return (
      <span className={`bg-bullish/10 border border-bullish/30 text-bullish text-xs px-3 py-1 rounded-xl font-bold tracking-wide flex items-center gap-1 ${className}`}>
        CALL
      </span>
    );
  } else if (isSell) {
    return (
      <span className={`bg-bearish/10 border border-bearish/30 text-bearish text-xs px-3 py-1 rounded-xl font-bold tracking-wide flex items-center gap-1 ${className}`}>
        PUT
      </span>
    );
  }

  return (
    <span className={`bg-panel-elevated border border-border-token text-text-secondary text-xs px-3 py-1 rounded-xl font-bold tracking-wide flex items-center gap-1 ${className}`}>
      WAIT
    </span>
  );
};

// --- ANIMATED NUMBER ---
interface AnimatedNumberProps {
  value: number;
  decimals?: number;
  className?: string;
  flashTrigger?: string | number;
}
export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  decimals = 5,
  className = "",
  flashTrigger,
}) => {
  const [flash, setFlash] = useState<"up" | "down" | "">("");
  const prevValue = React.useRef(value);

  React.useEffect(() => {
    if (value !== prevValue.current && value > 0) {
      setFlash(value > prevValue.current ? "up" : "down");
      prevValue.current = value;
      const t = setTimeout(() => setFlash(""), 400);
      return () => clearTimeout(t);
    }
  }, [value, flashTrigger]);

  const flashClass =
    flash === "up"
      ? "text-bullish bg-bullish/10 px-1.5 rounded-lg transition-all"
      : flash === "down"
      ? "text-bearish bg-bearish/10 px-1.5 rounded-lg transition-all"
      : "text-white";

  return (
    <span className={`font-mono transition-all duration-300 ${flashClass} ${className}`}>
      {value > 0 ? value.toFixed(decimals) : "Synchronizing..."}
    </span>
  );
};

// --- EMPTY STATE ---
interface EmptyStateProps {
  title: string;
  description: string;
  icon?: React.ReactNode;
}
export const EmptyState: React.FC<EmptyStateProps> = ({ title, description, icon }) => {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-panel/30 border border-border-subtle rounded-2xl min-h-[160px]">
      {icon && <div className="text-text-muted mb-3">{icon}</div>}
      <h3 className="text-base font-bold text-text-secondary">
        {title}
      </h3>
      <p className="text-sm text-text-secondary mt-2 max-w-xs leading-relaxed font-sans">
        {description}
      </p>
    </div>
  );
};

// --- ERROR STATE ---
interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}
export const ErrorState: React.FC<ErrorStateProps> = ({ message, onRetry }) => {
  return (
    <div className="bg-bearish/5 border border-bearish/20 p-5 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-bearish text-sm font-medium">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
        <span className="leading-relaxed">{message}</span>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="bg-bearish/10 hover:bg-bearish/20 text-bearish border border-bearish/30 px-4 py-2 rounded-xl text-xs font-semibold tracking-wide transition-colors cursor-pointer min-h-[48px] flex items-center justify-center"
        >
          Retry Connection
        </button>
      )}
    </div>
  );
};

// --- BOTTOM SHEET ---
interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}
export const BottomSheet: React.FC<BottomSheetProps> = ({
  isOpen,
  onClose,
  title,
  children,
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 350 }}
            className="relative w-full max-w-lg bg-panel border-t border-border-token rounded-t-3xl p-6 md:p-8 shadow-2xl z-10 max-h-[85vh] overflow-y-auto flex flex-col"
          >
            <div className="w-12 h-1 bg-border-token rounded-full mx-auto mb-5" />
            <div className="flex justify-between items-center pb-4 border-b border-border-subtle mb-5">
              <h3 className="text-base font-bold text-white font-sans">
                {title}
              </h3>
              <button
                onClick={onClose}
                className="p-2 hover:bg-panel-elevated rounded-xl text-text-secondary hover:text-white transition-colors min-w-[48px] min-h-[48px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

// --- MODAL ---
interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  icon,
}) => {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/75 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="relative w-full max-w-lg bg-panel border border-border-token rounded-3xl shadow-2xl overflow-hidden flex flex-col z-10"
          >
            <div className="flex justify-between items-center px-6 py-4 md:px-8 md:py-5 border-b border-border-subtle">
              <div className="flex items-center gap-3">
                {icon && <div className="text-info">{icon}</div>}
                <h2 className="text-base md:text-lg font-bold text-white tracking-tight">
                  {title}
                </h2>
              </div>
              <button
                onClick={onClose}
                className="p-2 hover:bg-panel-elevated rounded-xl text-text-secondary hover:text-white transition-colors cursor-pointer min-w-[48px] min-h-[48px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 md:p-8">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};

// --- TABS ---
interface TabOption {
  id: string;
  label: string;
  icon?: React.ReactNode;
}
interface TabsProps {
  options: TabOption[];
  activeTab: string;
  onChange: (id: string) => void;
  className?: string;
}
export const Tabs: React.FC<TabsProps> = ({
  options,
  activeTab,
  onChange,
  className = "",
}) => {
  return (
    <div className={`flex bg-panel border border-border-subtle rounded-2xl p-1.5 gap-1.5 ${className}`}>
      {options.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-bold transition-all cursor-pointer min-h-[48px] ${
              isActive
                ? "bg-panel-elevated border border-border-token text-info font-bold"
                : "text-text-secondary hover:text-white"
            }`}
          >
            {tab.icon && <span className="w-4 h-4">{tab.icon}</span>}
            <span>{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
};

// --- COLLAPSIBLE SECTION ---
interface CollapsibleSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}
export const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  children,
  defaultOpen = true,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-border-subtle rounded-2xl overflow-hidden bg-panel/20">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-5 text-sm font-semibold text-white tracking-wide hover:bg-panel-hover border-b border-border-subtle transition-colors min-h-[48px]"
      >
        <span>{title}</span>
        {isOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="p-5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
