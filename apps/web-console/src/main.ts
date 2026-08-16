/** Web Console 唯一启动入口。 */
import 'element-plus/theme-chalk/el-reset.css';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './styles/tokens.css';
import './styles/global.css';

const application = createApp(App);
application.use(createPinia());
application.use(router);
application.mount('#app');
