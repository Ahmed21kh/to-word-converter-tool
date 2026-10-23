import { useEffect, useRef, useState } from 'react';

/**
 * Fade/slide an element in when it scrolls into view.
 * SSR and the first client render are always visible (good for SEO / no-JS); after mount, only
 * elements that are still below the fold are hidden and then revealed by an IntersectionObserver.
 */
export default function Reveal({ as: Tag = 'div', delay = 0, className = '', children, ...rest }) {
  const ref = useRef(null);
  const [state, setState] = useState('visible');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return undefined; // already on screen
    setState('hidden');
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setState('shown');
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const cls = { hidden: 'reveal-hidden', shown: 'reveal-shown', visible: '' }[state];
  return (
    <Tag ref={ref} style={{ '--d': `${delay}ms` }} className={`${className} ${cls}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}
