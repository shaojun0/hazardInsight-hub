import { useCallback, useEffect, useState } from 'react';

/** 极简 hash 路由：#/ 、#/records 、#/knowledge 、#/settings */
export function useHashRoute(): [string, (route: string) => void] {
  const read = () => {
    const h = window.location.hash.replace(/^#/, '');
    return h || '/';
  };
  const [route, setRoute] = useState<string>(read);

  useEffect(() => {
    const onHash = () => setRoute(read());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((route: string) => {
    window.location.hash = route;
  }, []);

  return [route, navigate];
}
