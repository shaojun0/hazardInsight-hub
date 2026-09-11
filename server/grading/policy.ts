/** One policy source for the prompt and deterministic evaluator.
 * Enterprise B associations are explicit, never inferred from taxonomy or code prefixes.
 * Source: datas/rules/规则.txt; historical AB standard is audit-only, not model input.
 */
export const GRADING_POLICY_VERSION = 'evidence-risk-v3';
export interface EnterpriseRule {
  id: string;
  minimumGrade: 'B';
  description: string;
  // Alternatives are OR; each alternative's condition IDs must ALL be proven.
  alternatives: string[][];
  conditions: Record<string, string>;
}
function rule(id: string, description: string, conditions: Record<string,string>, alternatives?: string[][]): EnterpriseRule {
  return {id,description,minimumGrade:'B',conditions,alternatives:alternatives??[Object.keys(conditions)]};
}
export const ENTERPRISE_RULES: EnterpriseRule[] = [
  rule('BGC10','落差超过5米的孔洞与临边，防护措施缺失或失效。',{height:'实际坠落落差严格超过5米；楼层标高、负标高和约5米均不能证明超过5米',barrier:'同一孔洞或临边的防坠落防护缺失或失效'}),
  rule('BJS02','脚手架未设置连墙件或连墙件整层缺失。',{structure:'对象为需设置连墙件的脚手架',failure:'未设置连墙件或整层缺失；单个松动不能等同整层缺失'}),
  rule('BMB01','预埋件、锚固点或紧固螺栓数量、布置不满足设计或方案。',{object:'对象为结构连接、锚固或预埋件',failure:'输入明确其布置、数量、材质或安装违反设计/方案，而非一般标识问题'}),
  rule('BDQ05','介入带电区域或停电检修时，隔离边界不完整、未验电或无专人监护。',{activity:'正在介入带电区域或停电检修',failure:'该作业隔离边界不完整、作业前未验电或操作无专人监护'}),
  rule('BDQ06','电气停送电操作无授权、无监护或隔离失效。',{activity:'电气设备停送电、调试隔离操作',failure:'该操作人员无授权、未执行监护制或实际隔离失效；标牌模糊不等同隔离失效'}),
  rule('BYX01','未辨识施工现场有限空间，且未在显著位置设置警示标志。',{space:'确为有限空间',unidentified:'明确未辨识或未建立有限空间台账',sign:'未设置警示标志'}),
  rule('BYX02','有限空间作业缺少专项教育培训或未执行先通风再检测后作业。',{activity:'实际进入有限空间作业',failure:'明确未专项培训或未执行先通风、再检测、后作业；仅票证或登记问题不能证明此条件'}),
  rule('BYX04','有限空间作业现场缺少必要气体检测、通风、呼吸防护或救援设施。',{activity:'实际有限空间作业',failure:'必要检测、通风、呼吸防护或应急救援设施缺失/失效；无检验记录不能单独证明功能失效'}),
  rule('BWX01','危险化学品未按标准分类分区、超量超品种或禁配物质混存。',{chemicals:'明确具体危险化学品或已确认为危化品',storage:'明确未分类分区、超量超品种或禁配混存；普通物料混放、单瓶无标签不满足'}),
  rule('BJT03','人员与车辆共用道路，未设置人车分流实体隔离。',{shared:'明确同一道路存在人车共同通行',separation:'未设置人车分流实体隔离'}),
  rule('BXF13','室外消防给水系统未设置、不符合标准或不能正常使用。',{system:'室外消防给水系统或承担该功能的消火栓',failure:'未设置或已不能正常供水；巡检标签/箱门问题不等同不能供水'}),
  rule('BTS03','特种设备安全附件、安全保护装置缺失或失灵，继续使用。',{equipment:'特种设备安全附件或安全保护装置',failure:'实际缺失或失灵；无铅封/检验牌不能单独证明功能失效',use:'仍继续使用该设备'}),
  rule('BGJ12','角磨机使用不当，存在反弹失控、砂轮破裂风险。',{activity:'正在使用角磨机',failure:'带齿或开裂锯片、切割片侧面打磨、身体固定工件、未使用手柄等具体危险使用方式'}),
  rule('BGJ10','混凝土泵送防爆管、防甩击或防倾覆措施不到位。',{activity:'混凝土泵送或泵车正在使用',failure:'防爆管、防甩击、防倾覆安全措施缺失或失效'}),
  rule('BQZ02','使用达到报废标准的起重机械或吊索具进行吊装。',{activity:'正在起重吊装',discard:'输入明确达到报废标准/已报废，或提供与适用报废条款一致的测量证据；一般磨损不得推定达到报废'}),
  rule('BGL07','安全高风险作业不具备安全条件即开工或越点施工。',{activity:'具体高风险作业已经开展',failure:'明确关键先决安全条件不具备或越过控制点；不能只因文字含B级作业票就判B'}),
];

export const SCORING_GUIDANCE = `严重度取输入支持的可信事故后果，不能取无限假设下的最坏后果：1=无伤害/外观记录问题；2=轻微可逆伤害；3=需治疗伤害或局部设备损坏；4=重伤或重大设备损坏；5=死亡、多人严重伤害或核安全功能损失。后果推断必须有事实引用，事故名称本身不证明严重度。
可能性不是描述长度或危险关键词频率：1=明确停用隔离且有效屏障阻断路径；2=缺陷局部、事故还需额外触发条件；3=已存在可达危险路径/作业暴露；4=作业持续且关键屏障失效或有现实失稳征兆；5=事故正在发展。未知不得填1假装几乎不发生，必须列缺失信息。
暴露 none 必须有无人进入/停用隔离事实；possible=可达但未见实际人员；present=人员实际作业/接触；multiple=明确多人共同受影响；unknown=未提供。只有明确局限于文书/外观/秩序且无事故路径的问题可用not_applicable（屏障同理），引用证明问题性质的事实；不是把未知人员假设为无人。不能把厂房标高当坠落落差。
屏障 intact=明确有效阻断事故路径；degraded=局部缺陷但不是关键安全功能丧失；failed=具体关键屏障缺失或失效；unknown=信息不足。immediateDanger=true 必须有正在发展的事故或人员正暴露于无有效屏障的迫近危险，建议立即整改不是危险已经迫近的证据。`;

export function gradingPolicyPrompt(): string {
  return `当前企业ABCD策略版本 ${GRADING_POLICY_VERSION}。这是企业风险处置等级，不能用它替代法规意义的重大事故隐患认定。
${SCORING_GUIDANCE}
优先级：输入事实/否定与时间状态 > 全条件企业规则 > 结构化场景门槛 > 风险矩阵辅助 > 相似案例。法规或星标适用性另行复核，禁止擅自把a/b/c业务类目或规则编码首字母当等级。
A：严重度>=4、关键屏障失效、实际人员暴露、可能性>=4或立即危险=true 四项同时成立。没有现实暴露与事故路径，不能仅凭死亡/触电/坠落/核岛判A。
B：企业规则所有必要条件被事实证实，或严重度>=4且关键屏障失效且可能性>=3且存在可能/实际暴露。未达到A的迫近性门槛。
C：需要医疗处理的伤害/设备局部损坏有可信事故路径（严重度>=3），或辅助风险值>=6，或关键屏障已经失效；尚不满足AB。仅有“可能触电、坠落”字样不能建立路径。未知关键因素须复核。
D：严重度<=2、风险值<6且未证实关键屏障失效的局部轻微问题。包括局部整理、标签、检查记录及后果轻微的非关键附件缺陷。不能仅因同属电气/脚手架/消防类别就套用严重后果。若当前事实已支持轻微后果但暴露未知，可暂定D并复核；未知不是确认无人。若连缺陷对象/性质都不明确，则暂定C并要求补充。影响关键控制功能、稳定承载或逃生功能的缺陷不适用D。
不同风险逐项建scenarios，分别定级后取最高支持等级。不得把不同场景的严重度、可能性相乘，不按隐患数量累加升级。
企业规则目录（alternatives内为且，不同alternatives为或；只有列出的规则可作企业B下限；未满足条件保留unknown/not_met并列补充信息）：
${JSON.stringify(ENTERPRISE_RULES)}
其他检索条款只供适用性论证/复核，不得未经配置自行新增等级覆盖。历史案例是辅助：比较活动状态、关键屏障、落差、人员暴露、范围，标签差异不得用投票替代事实。`;
}
