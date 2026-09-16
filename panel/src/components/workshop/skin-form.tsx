'use client';

// ============================================================
//  skin-form.tsx  -  o cadastro de uma skin do Workshop.
//
//  ####  UM SÓ, PARA CRIAR E PARA EDITAR  ####
//
//  Criar e editar uma skin são a MESMA pergunta — "qual item, qual
//  arte, e quem tem direito?" —, e a única diferença é de onde vêm
//  os valores iniciais. Dois formulários divergiriam no primeiro
//  campo novo, e o que faltasse num deles só apareceria no dia em
//  que alguém fosse editar.
//
//  ####  ELE NÃO FALA COM A API  ####
//
//  Quem chama o agente é o painel-pai. Este arquivo só tem um
//  rascunho e devolve o que o admin montou — é o que permite a
//  mesma caixa servir ao cadastro novo e à edição sem saber qual
//  das duas rotas vai ser usada.
//
//  ####  O QUE A RECUSA DO AGENTE PRECISA VIRAR AQUI  ####
//
//  As recusas desta rota não são erros de digitação: são conflitos
//  com OUTRA linha do catálogo, e cada uma tem uma saída
//  diferente. Um toast que some em cinco segundos não serve — a
//  frase fica no formulário, com o que fazer escrito embaixo.
// ============================================================

import { Loader2 } from 'lucide-react';
import { useState } from 'react';

import { ItemCombobox } from '@/components/item-combobox';
import { ItemIcon } from '@/components/item-icon';
import { ServerPicker, type WorkshopServerOption } from '@/components/workshop/server-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { ApiError, type WorkshopSkin, type WorkshopSkinInput } from '@/lib/api';

export interface SkinFormProps {
  /** Os valores iniciais. */
  readonly value: WorkshopSkinInput;
  /** A skin que está sendo editada, se houver. Ausente = é nova. */
  readonly skin?: WorkshopSkin;
  readonly servers: readonly WorkshopServerOption[];
  readonly busy: boolean;
  /** A última recusa do agente. Fica na tela até o próximo Salvar. */
  readonly error?: ApiError | null;
  readonly onSave: (value: WorkshopSkinInput) => void;
  readonly onCancel: () => void;
}

/** Uma skin que ainda não existe. */
export function blankSkin(): WorkshopSkinInput {
  return {
    label: '',
    shortname: '',
    skinId: '',
    permission: '',
    hideInStreamer: true,
    enabled: true,
    servers: [],
  };
}

/**
 * A permissão que o agente vai gravar se o campo ficar em branco.
 *
 * ####  ISTO É UMA PRÉVIA, E NÃO A REGRA  ####
 *
 * Quem decide é o `normalizePermission` de
 * `core/src/types/workshop.ts`, e é ele que grava. Esta cópia
 * existe só para o campo mostrar, ANTES de salvar, o que vai sair
 * do nome — digitar permissão à mão em toda skin é como se erra uma
 * letra e se descobre semanas depois, com o jogador reclamando que
 * não recebe o item.
 *
 * Se as duas divergirem, quem está certo é o agente: o que a tela
 * mostra é um exemplo, e o valor real volta na resposta.
 */
export function previewPermission(label: string): string {
  const slug = label
    .normalize('NFD')
    // U+0300–U+036F são os diacríticos que o NFD acabou de separar
    // da letra. Escritos como escape de propósito: um acento solto
    // no meio do código é invisível no editor.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `origemzworkshop.${slug === '' ? 'skin' : slug.slice(0, 40)}`;
}

/**
 * O que fazer com a recusa, por código de contrato.
 *
 * A FRASE do agente já explica o que aconteceu — ela conhece a
 * outra linha do catálogo e a nossa não. O que falta é a saída, e é
 * só isso que mora aqui.
 */
function wayOut(code: string): string | null {
  switch (code) {
    case 'DUPLICATE_ITEM':
      return (
        'Duas saídas: abra a outra skin desse item e DESLIGUE ela (a marca dela fica no ' +
        'catálogo), ou tire daqui os servidores em que ela já vale — duas skins do mesmo item ' +
        'em servidores diferentes não se encontram.'
      );

    case 'DUPLICATE_MARK':
      return 'Esse par item + número já está cadastrado. Confira o número na página da oficina.';

    case 'DUPLICATE_PERMISSION':
      return 'Mude o nome da skin, ou escreva uma permissão diferente no campo Permissão.';

    case 'UNKNOWN_BASE_ITEM':
      return 'Escolha o item pela lista do campo acima: o shortname é o do jogo, em inglês.';

    default:
      return null;
  }
}

export function SkinForm({
  value,
  skin,
  servers,
  busy,
  error = null,
  onSave,
  onCancel,
}: SkinFormProps) {
  const [draft, setDraft] = useState<WorkshopSkinInput>(value);

  function patch(change: Partial<WorkshopSkinInput>): void {
    setDraft((current) => ({ ...current, ...change }));
  }

  const permission = draft.permission ?? '';
  const chosenServers = draft.servers;
  const problem =
    draft.label.trim() === ''
      ? 'Dê um nome à skin.'
      : draft.shortname.trim() === ''
        ? 'Escolha o item do jogo que vai receber a aparência.'
        : draft.skinId === ''
          ? 'Falta o número da skin publicada no Workshop.'
          : null;

  return (
    <section className="space-y-4 border border-border bg-surface p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="flex items-center gap-2 font-condensed text-sm font-bold uppercase tracking-wide">
          {draft.shortname !== '' && <ItemIcon shortname={draft.shortname} size="sm" />}
          {skin === undefined ? 'Nova skin' : draft.label}
        </h4>
        {draft.skinId !== '' && (
          <span className="font-mono text-2xs text-muted">{draft.skinId}</span>
        )}
      </header>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">Nome</span>
        <Input
          value={draft.label}
          maxLength={60}
          placeholder="Pedra OrigemZ"
          className="mt-1 h-9"
          onChange={(event) => patch({ label: event.target.value })}
        />
        <span className="mt-1 block text-2xs text-muted">
          É por ele que você acha a skin nesta tela, e é dele que nasce a permissão. O jogador não
          vê este nome em lugar nenhum.
        </span>
      </label>

      <div className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Item do jogo
        </span>
        <div className="mt-1">
          <ItemCombobox
            value={draft.shortname}
            onValueChange={(shortname) => patch({ shortname })}
            placeholder="nome do item (rock, stones, hatchet) ou shortname"
          />
        </div>
        <span className="mt-1 block text-2xs text-muted">
          É o item que recebe a aparência — ele continua sendo a pedra do jogo, com a cara nossa.
          Nem todo item do Rust aceita skin; se o item não existir nesta versão, o agente recusa o
          cadastro na hora de salvar.
        </span>
      </div>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Número da skin no Workshop
        </span>
        <Input
          // `type="text"`, e não `number`: este número passa de 2^53
          // e um campo numérico o devolveria ARREDONDADO — uma skin
          // que não existe, que o jogo aceita em silêncio.
          type="text"
          inputMode="numeric"
          value={draft.skinId}
          maxLength={20}
          placeholder="3216783927"
          className="mt-1 h-9 font-mono"
          onChange={(event) => patch({ skinId: event.target.value.replace(/\D/g, '') })}
        />
        <span className="mt-1 block text-2xs text-muted">
          É o número que aparece no endereço da página da oficina (
          <span className="font-mono">…/?id=3216783927</span>). O servidor só guarda o número: quem
          baixa o modelo e a textura é o cliente de cada jogador, e{' '}
          <strong>a arte precisa estar publicada no Steam Workshop</strong> para ele conseguir. Um
          número que não corresponde a nada publicado não dá erro — o item simplesmente nasce com a
          cara normal.
        </span>
      </label>

      <label className="block">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Permissão (opcional)
        </span>
        <Input
          value={permission}
          maxLength={80}
          placeholder={previewPermission(draft.label)}
          className="mt-1 h-9 font-mono"
          onChange={(event) => patch({ permission: event.target.value })}
        />
        <span className="mt-1 block text-2xs text-muted">
          Quem não tiver esta permissão recebe o item comum — sem ela, ninguém ganha a skin. Deixe
          em branco e ela nasce do nome:{' '}
          <span className="font-mono text-foreground">{previewPermission(draft.label)}</span>. Dar a
          permissão é trabalho do Oxide, e o admin pode dá-la a um grupo (o VIP), ao vencedor de um
          evento ou a uma pessoa só.
        </span>
      </label>

      <div className="space-y-2 border-t border-border pt-3">
        <span className="font-condensed text-2xs uppercase tracking-wide text-muted">
          Em quais servidores
        </span>
        <ServerPicker
          value={chosenServers}
          servers={servers}
          onChange={(next) => patch({ servers: next })}
        />
      </div>

      <div className="space-y-3 border-t border-border pt-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-xl">
            <p className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Esconder de quem está em modo streamer
            </p>
            {/* ####  A PROTEÇÃO É DO PORTADOR, NÃO DO ESPECTADOR  ####
                MEDIDO: a skin é estado do ITEM e vai igual para todo
                mundo que olha aquele item. O admin que ligar isto
                achando que apaga a logo da tela do streamer vai se
                enganar — e a tela é o único lugar em que dá para
                dizer isso antes. */}
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Ligado, o item nasce <strong>sem a skin na mão de quem está em modo streamer</strong>
              : ele vê a pedra normal, e todo mundo à volta também vê a pedra normal no item DELE.{' '}
              <strong>
                A logo continua aparecendo nos itens dos outros jogadores no campo de visão dele
              </strong>{' '}
              — a skin viaja no item, e não na visão de quem olha. É o máximo que a rede do Rust
              permite.
            </p>
          </div>

          <Toggle
            on={draft.hideInStreamer}
            busy={false}
            onChange={(hideInStreamer) => patch({ hideInStreamer })}
            labels={['esconde', 'mostra']}
            label="Esconder esta skin de quem está em modo streamer?"
          />
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
          <div className="max-w-xl">
            <p className="font-condensed text-2xs uppercase tracking-wide text-muted">
              Esta skin está valendo?
            </p>
            <p className="mt-1 text-2xs leading-relaxed text-muted">
              Desligada não é apagada: a skin sai do jogo e o item volta a nascer normal, mas o
              cadastro e o número continuam aqui. É assim que se troca a arte de um item sem perder
              a anterior.
            </p>
          </div>

          <Toggle
            on={draft.enabled}
            busy={false}
            onChange={(enabled) => patch({ enabled })}
            labels={['valendo', 'desligada']}
            label="Esta skin está valendo?"
          />
        </div>
      </div>

      {error !== null && (
        <div role="alert" className="border border-rust bg-surface-2 p-3">
          <p className="font-condensed text-2xs font-bold uppercase tracking-wide text-rust">
            {/* Sem código é porque nem chegou ao agente — a rede
                caiu, ou ele não está no ar. Chamar isso de "recusa"
                mandaria o admin procurar defeito no formulário. */}
            {error.code === '' ? 'Não consegui gravar' : `O agente recusou (${error.code})`}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-foreground">{error.message}</p>
          {wayOut(error.code) !== null && (
            <p className="mt-2 border-l-2 border-amber pl-2 text-2xs leading-relaxed text-muted">
              {wayOut(error.code)}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        {/* O motivo fica visível o tempo todo, e não escondido atrás
            de um botão desabilitado sem explicação. */}
        <p className="text-2xs text-muted">{problem}</p>

        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy || problem !== null}
            onClick={() =>
              onSave({
                ...draft,
                label: draft.label.trim(),
                shortname: draft.shortname.trim(),
                // Vazia é omitida de propósito: é assim que o agente
                // sabe que deve tirá-la do nome. Mandar "" seria
                // pedir uma permissão em branco.
                ...(permission.trim() === '' ? { permission: undefined } : {}),
                servers: [...chosenServers],
              })
            }
          >
            {busy && <Loader2 aria-hidden="true" className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {skin === undefined ? 'Cadastrar' : 'Salvar'}
          </Button>
        </div>
      </div>
    </section>
  );
}
