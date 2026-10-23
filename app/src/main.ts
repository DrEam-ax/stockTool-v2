import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { installBackHandler } from '@/lib/back'
import './styles.css'

// Android 返回键 / 侧滑返回：有上一页则回退，根页面才退出 App
installBackHandler(router)

createApp(App).use(router).mount('#app')
