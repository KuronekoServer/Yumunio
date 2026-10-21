'use client';
// Adapted from shadcn/ui (MIT). Radix owns keyboard navigation and focus return.
import * as Primitive from '@radix-ui/react-dropdown-menu';
import {cn} from '../../lib/utils.js';
export const DropdownMenu=Primitive.Root;
export const DropdownMenuTrigger=Primitive.Trigger;
export function DropdownMenuContent({className,sideOffset=5,forceMount,...props}){return <Primitive.Portal forceMount={forceMount}><Primitive.Content forceMount={forceMount} data-slot="dropdown-menu-content" sideOffset={sideOffset} collisionPadding={8} className={cn(className)} {...props}/></Primitive.Portal>;}
export function DropdownMenuItem({className,...props}){return <Primitive.Item data-slot="dropdown-menu-item" className={cn(className)} {...props}/>;}
export function DropdownMenuSeparator(props){return <Primitive.Separator data-slot="dropdown-menu-separator" className="my-1 h-px bg-border" {...props}/>;}
