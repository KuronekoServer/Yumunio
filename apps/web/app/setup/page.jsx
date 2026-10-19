import {PageFrame} from '../../src/page-frame.jsx';
import {SetupScreen} from '../../src/setup-screen.jsx';

export const metadata={title:"はじめる / Get started"};

export default function Page(){
 return <PageFrame titleSuffix={metadata.title} styles={["preferences.css","setup.css","design-system.css"]} controllers={[]} htmlClass="preferences-page" bodyClass="setup-body">
<SetupScreen/>
 </PageFrame>;
}
