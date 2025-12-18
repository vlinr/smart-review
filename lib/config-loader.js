import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { defaultConfig, defaultRules } from './default-config.js';
import { logger } from './utils/logger.js';
import { t } from './utils/i18n.js';

export class ConfigLoader {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.reviewDir = path.join(projectRoot, '.smart-review');
    
    // 启动时清理遗留的临时文件
    this.cleanupTempFiles();
  }
  
  cleanupTempFiles() {
    try {
      const tempDir = path.join(this.reviewDir, 'local-rules', '.temp-smart-review');
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
          if (file.startsWith('temp-') && file.endsWith('.mjs')) {
            try {
              fs.unlinkSync(path.join(tempDir, file));
            } catch (e) {
              // 忽略单个文件删除失败
            }
          }
        }
        
        // 尝试删除空的临时目录
        try {
          fs.rmdirSync(tempDir);
        } catch (e) {
          // 忽略目录删除失败（可能不为空）
        }
      }
    } catch (error) {
      // 忽略清理过程中的错误，不影响主要功能
    }
  }

  async loadConfig() {
    let externalConfig = {};
    
    // 尝试加载外部配置文件
    const configPath = path.join(this.reviewDir, 'smart-review.json');
    if (fs.existsSync(configPath)) {
      try {
        const configContent = await fs.promises.readFile(configPath, 'utf8');
        externalConfig = JSON.parse(configContent);

      } catch (error) {
        logger.warn(t(undefined, 'external_config_parse_failed_warn', { error: error?.message || String(error) }));
      }
    }

    // 深度合并配置（外部配置覆盖默认配置）
    const mergedConfig = this.deepMerge(defaultConfig, externalConfig);
    
    // 设置项目根目录
    mergedConfig.projectRoot = this.projectRoot;
    mergedConfig.reviewDir = this.reviewDir;
    
    return mergedConfig;
  }

  async loadRules(config = {}) {
    // 2) 加载外部规则
    const externalRules = await this.loadExternalRules();

    // 根据配置决定规则加载策略
    if (config.useExternalRulesOnly) {
      // 仅使用外部规则模式：只返回外部规则，不加载内置规则
      logger.info(t(undefined, 'use_external_rules_only_info'));
      return externalRules;
    }

    // 默认合并模式：内置规则 + 外部规则合并
    // 1) 收集内置规则
    const builtInRules = Object.values(defaultRules).flat();

    // 3) 根据规则ID进行去重合并（外部规则优先生效）
    const ruleMap = new Map();

    for (const rule of builtInRules) {
      const key = rule.id || `${rule.pattern}__${rule.risk}`;
      ruleMap.set(key, rule);
    }

    for (const rule of externalRules) {
      const key = rule.id || `${rule.pattern}__${rule.risk}`;
      ruleMap.set(key, rule); // 外部规则覆盖同ID的内置规则
    }

    const allRules = Array.from(ruleMap.values());
    // 根据语言本地化规则的展示字段
    const localizedRules = this.localizeRules(allRules, config);
    return localizedRules;
  }

  async loadExternalRules() {
    const externalRules = [];
    // 改为读取 .smart-review/local-rules 作为静态规则目录，避免与AI提示目录冲突
    const rulesDir = path.join(this.reviewDir, 'local-rules');
    
    if (!fs.existsSync(rulesDir)) {
      return externalRules;
    }

    try {
      const ruleFiles = fs.readdirSync(rulesDir);
      
      for (const file of ruleFiles) {
        if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.json')) {
          const filePath = path.join(rulesDir, file);
          const rules = await this.loadRuleFile(filePath);
          externalRules.push(...rules);
        }
      }
    } catch (error) {
      logger.warn(t(undefined, 'load_external_rules_failed_warn', { error: error?.message || String(error) }));
    }
    
    return externalRules;
  }

  async loadRuleFile(filePath) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      
      if (ext === '.js' || ext === '.mjs') {
        let mod;
        
        if (ext === '.mjs') {
          // .mjs 文件肯定是 ES 模块，直接导入
          const fileUrl = `file://${filePath.replace(/\\/g, '/')}`;
          mod = await import(fileUrl);
        } else {
          // .js 文件需要判断 ESM/CommonJS
          const content = await fs.promises.readFile(filePath, 'utf8');
          const looksESM = /\bexport\b|^\s*import\b/m.test(content);
          
          if (looksESM) {
              // 为了避免 base64 编码导致转义字符丢失，我们创建一个临时的 .mjs 文件
              const tempDir = path.join(path.dirname(filePath), '.temp-smart-review');
              const tempFile = path.join(tempDir, `temp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.mjs`);
              
              try {
                // 确保临时目录存在
                if (!fs.existsSync(tempDir)) {
                  await fs.promises.mkdir(tempDir, { recursive: true });
                }
                
                // 写入临时文件
                await fs.promises.writeFile(tempFile, content, 'utf8');
                
                // 导入临时文件
                const fileUrl = `file://${tempFile.replace(/\\/g, '/')}`;
                mod = await import(fileUrl);
                
                // 清理临时文件
                fs.unlinkSync(tempFile);
                
                // 如果临时目录为空，删除它
                try {
                  fs.rmdirSync(tempDir);
                } catch (e) {
                  // 忽略删除目录失败的错误（可能不为空）
                }
              } catch (tempError) {
                // 如果临时文件方法失败，回退到原来的 base64 方法
                logger.warn(t(undefined, 'temp_file_method_failed_fallback_info', { error: tempError?.message || String(tempError) }));
                
                // 清理可能已创建的临时文件
                try {
                  if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                  }
                } catch (cleanupError) {
                  // 忽略清理错误
                }
                
                const base64 = Buffer.from(content, 'utf8').toString('base64');
                mod = await import(`data:text/javascript;base64,${base64}`);
              }
            } else {
              // CommonJS 规则：使用 createRequire 加载
              const require = createRequire(import.meta.url);
              mod = require(filePath);
            }
          }
        // 兼容多种导出风格
        const candidates = [mod?.rules, mod?.default?.rules, mod?.default, mod];
        for (const c of candidates) {
          if (Array.isArray(c)) return c;
        }
        return [];
      } else if (ext === '.json') {
        const content = await fs.promises.readFile(filePath, 'utf8');
        const config = JSON.parse(content);
        return config.rules || [];
      }
    } catch (error) {
      logger.warn(t(undefined, 'load_rule_file_failed_warn', { file: filePath, error: error?.message || String(error) }));
    }
    
    return [];
  }

  /**
   * 按当前语言对规则 name/message/suggestion 进行本地化。
   * 若翻译键不存在则保留原始内容。
   */
  localizeRules(rules, configOrLocale) {
    if (!Array.isArray(rules) || rules.length === 0) return rules;
    return rules.map((rule) => {
      const id = rule?.id;
      if (!id) return rule;

      const nameKey = `rule_${id}_name`;
      const msgKey = `rule_${id}_message`;
      const sugKey = `rule_${id}_suggestion`;

      const maybeName = t(configOrLocale, nameKey);
      const maybeMsg = t(configOrLocale, msgKey);
      const maybeSug = t(configOrLocale, sugKey);

      const localized = { ...rule };
      if (typeof maybeName === 'string' && maybeName !== nameKey) localized.name = maybeName;
      if (typeof maybeMsg === 'string' && maybeMsg !== msgKey) localized.message = maybeMsg;
      if (typeof maybeSug === 'string' && maybeSug !== sugKey) localized.suggestion = maybeSug;
      return localized;
    });
  }

  deepMerge(target, source) {
    const result = { ...target };
    
    for (const key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(result[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }
}