declare module 'nipplejs' {
  export interface JoystickManagerOptions {
    zone?: HTMLElement;
    color?: string;
    size?: number;
    threshold?: number;
    fadeTime?: number;
    multitouch?: boolean;
    maxNumberOfNipples?: number;
    dataOnly?: boolean;
    position?: { top?: string; left?: string; right?: string; bottom?: string };
    mode?: 'static' | 'semi' | 'dynamic';
    restOpacity?: number;
    catchDistance?: number;
    lockX?: boolean;
    lockY?: boolean;
    shape?: 'circle' | 'square';
    dynamicPage?: boolean;
    follow?: boolean;
  }

  export interface JoystickManager {
    on(event: string, handler: (evt: any, data: any) => void): void;
    off(event: string, handler: (evt: any, data: any) => void): void;
    destroy(): void;
    get(id: number): any;
  }

  export function create(options: JoystickManagerOptions): JoystickManager;
}
