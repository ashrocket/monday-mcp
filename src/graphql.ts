/** Every GraphQL document the server sends, in one place. */

/** Fields shared by each item read. Mirror columns need their own fragment. */
const COLUMN_VALUE_FIELDS = `
  id
  type
  text
  value
  column { id title }
  ... on MirrorValue { display_value }
  ... on BoardRelationValue { display_value linked_item_ids }
  ... on DependencyValue { display_value }
`;

export const ME = /* GraphQL */ `
  query Me {
    me {
      id
      name
      email
      is_admin
      is_guest
      account {
        id
        name
        slug
        tier
      }
    }
  }
`;

export const LIST_BOARDS = /* GraphQL */ `
  query ListBoards($limit: Int!, $page: Int!, $ids: [ID!], $workspaceIds: [ID]) {
    boards(
      limit: $limit
      page: $page
      ids: $ids
      workspace_ids: $workspaceIds
      order_by: used_at
    ) {
      id
      name
      description
      state
      board_kind
      items_count
      updated_at
      workspace { id name }
      owners { id name }
    }
  }
`;

export const GET_BOARD = /* GraphQL */ `
  query GetBoard($ids: [ID!]) {
    boards(ids: $ids) {
      id
      name
      description
      state
      board_kind
      items_count
      permissions
      workspace { id name }
      groups { id title color position }
      columns { id title type settings_str description }
      tags { id name }
    }
  }
`;

export const LIST_ITEMS = /* GraphQL */ `
  query ListItems($boardId: ID!, $limit: Int!, $queryParams: ItemsQuery) {
    boards(ids: [$boardId]) {
      id
      name
      items_page(limit: $limit, query_params: $queryParams) {
        cursor
        items {
          id
          name
          state
          created_at
          updated_at
          group { id title }
          column_values { ${COLUMN_VALUE_FIELDS} }
        }
      }
    }
  }
`;

export const NEXT_ITEMS_PAGE = /* GraphQL */ `
  query NextItemsPage($cursor: String!, $limit: Int!) {
    next_items_page(cursor: $cursor, limit: $limit) {
      cursor
      items {
        id
        name
        state
        created_at
        updated_at
        board { id name }
        group { id title }
        column_values { ${COLUMN_VALUE_FIELDS} }
      }
    }
  }
`;

export const GET_ITEMS = /* GraphQL */ `
  query GetItems($ids: [ID!]!) {
    items(ids: $ids) {
      id
      name
      state
      url
      created_at
      updated_at
      board { id name }
      group { id title }
      creator { id name }
      column_values { ${COLUMN_VALUE_FIELDS} }
      subitems { id name state }
    }
  }
`;

export const GET_ITEM_BOARDS = /* GraphQL */ `
  query GetItemBoards($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board { id }
    }
  }
`;

export const GET_ITEM_UPDATES = /* GraphQL */ `
  query GetItemUpdates($ids: [ID!]!, $limit: Int!) {
    items(ids: $ids) {
      id
      name
      updates(limit: $limit) {
        id
        body
        text_body
        created_at
        creator { id name }
        replies { id text_body created_at creator { id name } }
      }
    }
  }
`;

export const LIST_USERS = /* GraphQL */ `
  query ListUsers($limit: Int!, $ids: [ID!], $kind: UserKind) {
    users(limit: $limit, ids: $ids, kind: $kind) {
      id
      name
      email
      enabled
      is_admin
      is_guest
      title
    }
  }
`;

export const LIST_WORKSPACES = /* GraphQL */ `
  query ListWorkspaces($limit: Int!) {
    workspaces(limit: $limit) {
      id
      name
      kind
      description
    }
  }
`;

export const CREATE_ITEM = /* GraphQL */ `
  mutation CreateItem(
    $boardId: ID!
    $groupId: String
    $itemName: String!
    $columnValues: JSON
    $createLabels: Boolean
  ) {
    create_item(
      board_id: $boardId
      group_id: $groupId
      item_name: $itemName
      column_values: $columnValues
      create_labels_if_missing: $createLabels
    ) {
      id
      name
      url
      group { id title }
    }
  }
`;

export const CREATE_SUBITEM = /* GraphQL */ `
  mutation CreateSubitem(
    $parentItemId: ID!
    $itemName: String!
    $columnValues: JSON
    $createLabels: Boolean
  ) {
    create_subitem(
      parent_item_id: $parentItemId
      item_name: $itemName
      column_values: $columnValues
      create_labels_if_missing: $createLabels
    ) {
      id
      name
      board { id name }
    }
  }
`;

export const CHANGE_COLUMN_VALUES = /* GraphQL */ `
  mutation ChangeColumnValues(
    $boardId: ID!
    $itemId: ID!
    $columnValues: JSON!
    $createLabels: Boolean
  ) {
    change_multiple_column_values(
      board_id: $boardId
      item_id: $itemId
      column_values: $columnValues
      create_labels_if_missing: $createLabels
    ) {
      id
      name
      column_values { ${COLUMN_VALUE_FIELDS} }
    }
  }
`;

export const CHANGE_ITEM_NAME = /* GraphQL */ `
  mutation ChangeItemName($boardId: ID!, $itemId: ID!, $value: JSON!) {
    change_simple_column_value(
      board_id: $boardId
      item_id: $itemId
      column_id: "name"
      value: $value
    ) {
      id
      name
    }
  }
`;

export const MOVE_ITEM_TO_GROUP = /* GraphQL */ `
  mutation MoveItemToGroup($itemId: ID!, $groupId: String!) {
    move_item_to_group(item_id: $itemId, group_id: $groupId) {
      id
      name
      group { id title }
    }
  }
`;

export const ARCHIVE_ITEM = /* GraphQL */ `
  mutation ArchiveItem($itemId: ID!) {
    archive_item(item_id: $itemId) {
      id
      name
      state
    }
  }
`;

export const DELETE_ITEM = /* GraphQL */ `
  mutation DeleteItem($itemId: ID!) {
    delete_item(item_id: $itemId) {
      id
      name
      state
    }
  }
`;

export const CREATE_UPDATE = /* GraphQL */ `
  mutation CreateUpdate($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
      body
      created_at
      creator { id name }
    }
  }
`;
