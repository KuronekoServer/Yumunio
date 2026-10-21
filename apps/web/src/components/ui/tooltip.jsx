'use client';
import * as Primitive from '@radix-ui/react-tooltip';
export const TooltipProvider=Primitive.Provider;
export const Tooltip=Primitive.Root;
export const TooltipTrigger=Primitive.Trigger;
export function TooltipContent({children,sideOffset=6,...props}){return <Primitive.Portal><Primitive.Content data-slot="tooltip-content" sideOffset={sideOffset} collisionPadding={8} {...props}>{children}</Primitive.Content></Primitive.Portal>;}
