/** 极简事件总线：用于把"发生了什么"广播给音效 / 特效 / 统计等旁路系统。 */

export type Listener<T> = (payload: T) => void;

export class EventBus {
  private map = new Map<string, Set<Listener<unknown>>>();

  on<T>(event: string, fn: Listener<T>): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn as Listener<unknown>);
    return () => this.off(event, fn);
  }

  off<T>(event: string, fn: Listener<T>): void {
    this.map.get(event)?.delete(fn as Listener<unknown>);
  }

  emit<T>(event: string, payload: T): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const fn of set) {
      (fn as Listener<T>)(payload);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

/** 全局事件名常量。 */
export const GameEvents = {
  Shoot: 'shoot',
  HitEnemy: 'hit-enemy',
  HitPlayer: 'hit-player',
  EnemyDied: 'enemy-died',
  Explosion: 'explosion',
  Pickup: 'pickup',
  Door: 'door',
  Reload: 'reload',
  Skill: 'skill',
  BossPhase: 'boss-phase',
  BossDied: 'boss-died',
  RoomCleared: 'room-cleared',
  PlayerDied: 'player-died',
  UiClick: 'ui-click',
} as const;
