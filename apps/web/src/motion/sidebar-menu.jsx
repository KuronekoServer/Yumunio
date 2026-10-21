'use client';
import {Children,Fragment,isValidElement,useState} from 'react';
import {AnimatePresence,motion} from 'motion/react';
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent,DropdownMenuItem} from '../components/ui/dropdown-menu.jsx';
import {Button} from '../components/ui/button.jsx';
import {surfaceTransition} from '../../public/ui-motion-policy.js';
import {useReducedMotionPreference} from './hooks.js';

function menuItems(children){return Children.toArray(children).flatMap(child=>isValidElement(child)&&child.type===Fragment?menuItems(child.props.children):[child]);}

/** Non-modal menus leave the independent editor mounted and keep selection.
 * Radix handles arrows, type-ahead, Escape, outside clicks and focus return. */
export function SidebarMenu({label,icon,children,className='',compact=false,portal=false,disabled=false}){
 const [open,setOpen]=useState(false),reduced=useReducedMotionPreference();
 return <div className={'sidebar-library motion-sidebar-menu '+className}>
  <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
   <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size={compact?'icon-sm':'sm'} className="sidebar-menu-trigger" disabled={disabled} aria-label={label}>{icon}<span className={compact?'sr-only':undefined}>{label}</span></Button></DropdownMenuTrigger>
   <AnimatePresence>{open&&<DropdownMenuContent forceMount asChild side={portal?'right':'bottom'} align="start" aria-label={label}
    onCloseAutoFocus={event=>{if(document.activeElement?.closest('dialog[open],[role="dialog"]'))event.preventDefault();}}>
    <motion.div key="menu" initial={{opacity:0,y:reduced?0:-4}} animate={{opacity:1,y:0}} exit={{opacity:0,y:reduced?0:-4}} transition={surfaceTransition('menu',reduced)}>
     {menuItems(children).map((child,index)=>isValidElement(child)?<DropdownMenuItem key={child.key??index} asChild disabled={child.props.disabled===true}>{child}</DropdownMenuItem>:null)}
    </motion.div>
   </DropdownMenuContent>}</AnimatePresence>
  </DropdownMenu>
 </div>;
}
