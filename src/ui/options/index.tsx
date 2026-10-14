import { render } from 'solid-js/web';
import { applyCachedTheme } from '../shared/theme';
import { App } from './App';
import '../styles.css';

// 先把上次记住的主题套上，避免打开设置页时闪一下错误的颜色。
// 之后 useApplyTheme() 会用 chrome.storage 里的真实设置纠正它。
applyCachedTheme();

render(() => <App />, document.getElementById('root')!);
