import { useCallback, useEffect, useState } from 'react';
import { fetchHealth } from '../api/scorecraft';
import type { Health } from '../api/scorecraft';

/** 本机识别服务状态：挂载时检查一次，之后由“重新检查”按钮手动刷新。 */
export function useHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  const refreshHealth = useCallback(async () => {
    try {
      const data = await fetchHealth();
      setHealth(data);
      setHealthError(false);
    } catch {
      setHealth(null);
      setHealthError(true);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
  }, [refreshHealth]);

  return { health, healthError, refreshHealth };
}
