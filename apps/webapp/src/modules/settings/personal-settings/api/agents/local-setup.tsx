import { InstallConfig } from './install-config';

/**
 * How to connect a harness on your own machine, readable before you have made
 * an agent.
 *
 * This existed before as a greyed-out block under the words "generate a token
 * above to fill these in", stapled to the create form — inert, and reading as
 * something broken rather than as instructions. Removing it went too far the
 * other way: whether to set an agent up at all is a question you answer by
 * reading what setting one up involves, and that has to be available before
 * anything is created.
 *
 * So it is neither a preview nor an afterthought: its own section, at full
 * strength, with a placeholder where the token goes. The surrounding
 * `SettingSection` already says the token arrives when you create an agent, so
 * nothing here has to apologise for not having one.
 */
export function LocalSetup() {
  return <InstallConfig />;
}
