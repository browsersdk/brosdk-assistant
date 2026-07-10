import { defineConfig } from 'wxt'

export default defineConfig({
  outDir: 'dist',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Brosdk Assistant',
    description: 'Chrome side panel assistant backed by a Rust native host.',
    version: '0.1.0',
    permissions: ['nativeMessaging', 'sidePanel', 'storage', 'tabs', 'scripting'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    options_page: 'settings.html',
    action: {
      default_title: 'Brosdk Assistant',
      default_icon: {
        '16': 'icons/message-bot-16.png',
        '32': 'icons/message-bot-32.png',
        '48': 'icons/message-bot-48.png',
        '128': 'icons/message-bot-128.png',
      },
    },
    icons: {
      '16': 'icons/message-bot-16.png',
      '32': 'icons/message-bot-32.png',
      '48': 'icons/message-bot-48.png',
      '128': 'icons/message-bot-128.png',
    },
  },
})
