import { render } from 'preact';
import { App } from './App';
import { AuthProvider } from './auth';
import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import './themes.css';
import './styles.css';

render(<AuthProvider><App /></AuthProvider>, document.getElementById('app')!);