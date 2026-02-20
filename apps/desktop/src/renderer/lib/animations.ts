// Simple animation utilities for framer-motion
export const springs = {
  gentle: {
    type: 'spring',
    stiffness: 300,
    damping: 30,
  },
  bouncy: {
    type: 'spring',
    stiffness: 400,
    damping: 25,
  },
  smooth: {
    type: 'spring',
    stiffness: 200,
    damping: 20,
  },
};

export const variants = {
  fadeUp: {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -20 },
  },
  fade: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0 },
  },
};
