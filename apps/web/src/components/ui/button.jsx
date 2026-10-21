// Adapted from shadcn/ui (MIT), https://ui.shadcn.com/r/styles/new-york-v4/button.json
import {Slot} from '@radix-ui/react-slot';
import {cva} from 'class-variance-authority';
import {cn} from '../../lib/utils.js';
export const buttonVariants=cva('inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',{
 variants:{variant:{default:'bg-primary text-primary-foreground hover:bg-primary/90',outline:'border border-border bg-background hover:bg-accent',secondary:'bg-secondary text-secondary-foreground hover:bg-secondary/80',ghost:'bg-transparent text-foreground hover:bg-accent',link:'text-primary underline-offset-4 hover:underline'},size:{default:'h-9 px-4 py-2',sm:'h-8 px-3 text-sm','icon-sm':'size-8 p-1.5',icon:'size-9 p-2'}},defaultVariants:{variant:'default',size:'default'}});
export function Button({className,variant='default',size='default',asChild=false,...props}){const Comp=asChild?Slot:'button';return <Comp data-slot="button" data-variant={variant} data-size={size} className={cn(buttonVariants({variant,size,className}))} {...props}/>;}
